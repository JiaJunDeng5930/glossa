# Glossa Engineering Notes

Glossa is a Chrome Manifest V3 extension built with TypeScript, esbuild, native DOM and Shadow DOM. The extension translates unfamiliar English words inline on the page, keeps vocabulary state in storage, and delegates AI and Anki work to the background service worker.

## Module Boundaries

- `src/content/*`: page scanning, DOM range mapping, inline gloss wrappers, and shortcut-based selection mode. Content code sends requests to background and keeps page interaction local.
- `src/background/*`: message orchestration, AI calls, AnkiConnect calls, cache lookup, and vocabulary state persistence. Service worker code persists task state and cache results.
- `src/core/*`: vocabulary state machine, lemma normalization, known-word-list loading, and cache key construction.
- `src/storage/db.ts`: minimal wrapper for `chrome.storage.local` settings and IndexedDB-backed lexicon/cache stores.
- `src/options/*`: settings UI for shortcut, known-word filter, AI endpoint, OpenAI Responses API key, AnkiConnect endpoint, prompts, and connection checks.
- `src/popup/*`: action popup menu. The translate button sends a tab message that activates content translation for the current page.
- `src/shared/shortcut.ts`: shared shortcut capture and matching rules for options and content selection mode.

## State Model

Vocabulary records use one table keyed by `lang:lemma`. `candidate` records become `known` after a displayed gloss. A clicked word becomes `learning_active`, receives an `expiresAt`, and stays eligible for display until expiry. Expired `learning_active` records transition to `known`. `ignored` records stay hidden.

Settings contain `autoTranslateEnabled`, `translateShortcutKey`, `shortcutKey`, `appearance` for inline label colors, opacity, font family, and font size, plus `knownWordList`, `prompts.gloss`, and `prompts.ankiCard`. The extension is fixed to English source text and `zh-CN` gloss output through `GLOSS_TARGET_LANG`. Anki settings contain endpoint, deck, and model name; note creation writes `Front` and `Back`, so options only enables model names whose fields include both. Prompt text, OpenAI provider, and reasoning effort are included in cache versioning so edits create fresh gloss/card cache entries. OpenAI providers are `openai-responses`, `openai-chat-completions`, and `openai-completions`; `glossa-backend` uses `/gloss` with frame-shaped `items` for gloss batches and `/anki-card` for card creation.

Content translation has a page-local activation flag. It starts from `settings.autoTranslateEnabled`, turns on when the action popup sends `glossa.activateTranslation`, toggles when the page receives `settings.translateShortcutKey`, and resets to the setting value after a route URL change. Toggling off clears queued scans, closes gloss ports, unwraps rendered tokens, and keeps mutation and scroll rescans idle while the page is inactive.

Runtime messages use `src/shared/messages.ts`. Settings and word-click messages use request/response envelopes with `type`, `version`, `requestId`, `source`, `target`, `createdAt`, and `payload`. Gloss lookup uses a `chrome.runtime.connect({ name: "gloss.session" })` port: content sends `gloss.scan.start`, streams `gloss.scan.chunk`, sends `gloss.scan.end`, receives `gloss.chunk.ack` for backpressure, then receives streamed `gloss.token` outcomes with `ready`, `pending`, `hidden`, or `error` before `gloss.done`. Content opens a fresh port for each scan and disconnects all gloss ports on route changes and teardown.

Background gloss resolution is lookup-first and chunked: page memory replay, lexicon state, IndexedDB gloss cache, then framed AI. Memory and cache hits emit `ready` immediately and update shown state. `known` and `ignored` emit `hidden`. AI misses emit `pending`, enter an in-flight map keyed by durable gloss cache key, then owner misses enter an AI frame buffer. Frames close at 32 misses or 50ms and execute through a global serial AI outlet with concurrency 1. Duplicate misses subscribe to the owner in-flight result and receive per-token `ready` or `error`.

IndexedDB reads for lexicon and gloss cache pass through a DB read coalescer. It batches same-store key reads within an 8ms window and exposes aggregate trace events through `service-worker.db.read`. Visible lookup outcomes are emitted before shown-state writes complete.

Content scanning starts from visible, non-editable, non-code text nodes, including open shadow roots and extension-injected frames, and produces DOM-grounded tokens with text-node offsets, source fingerprints, and scan versions. Non-Glossa DOM mutations invalidate the active scan version and schedule a new scan; pending wrappers may still accept stale-session outcomes when their stored surface, lemma, offsets, fingerprint, and local text context still match. `overlay.applyTokenOutcome(token, outcome, scanVersion)` handles current-session updates, and stale pending reconciliation handles slow results after ordinary DOM changes. Glosses render as inline `data-glossa-token` wrappers that keep the source word on the text baseline, reserve text-flow space, place the label above the source word, and align their vertical centerlines. Glossa-owned nodes carry `data-glossa-owned="1"`, `translate="no"`, and `notranslate` so future scans and mutation handling can identify them.

Structured diagnostics use `src/shared/diagnostics.ts`. Trace events include component, operation, result, request id, sender tab/frame/document fields when Chrome provides them, and sanitized URLs. `sanitizeUrl` keeps only origin and path, so query strings and fragments stay out of logs. Performance traces include `content.scan.chunk`, `service-worker.lookup.chunk`, `service-worker.db.read`, `service-worker.ai.frame`, and `service-worker.scan.done`.

Runtime error payloads are diagnostic data: `reason`, `message`, optional `service`, and optional `status`. Background code reports diagnostic facts through message and port payloads. Frontend code maps those diagnostics to user-facing text through `src/shared/userMessages.ts`; inline page UI keeps the `×` badge and exposes the text through title and aria-label.

Known-word filter assets live in `assets/known-wordlists/`. `junior-high` is the unstarred compulsory-education subset and `senior-high` is the full 3000-word appendix from the Ministry of Education high-school English curriculum standard zip. Extra filter presets cover CET-4, CET-6, TOEFL, GRE, and COCA 20000.

The options page follows `DESIGN.md`: `#f5f5f7` canvas, white 28px cards, no shadows, and a single blue Save action. Connection test buttons are text buttons placed directly below Reasoning effort and Anki deck.

## Commands

- `npm run typecheck`: TypeScript contract check.
- `npm run test`: Vitest unit and integration tests.
- `npm run build`: bundle `content.js`, `background.js`, `options.js`, and `popup.js` into `dist/`.
- `npm run test:e2e`: Playwright browser check against the built content bundle.
- `npm run verify`: full local gate.
- `npm run req:check:all`: strict full-source requirement anchor audit for every TypeScript code unit in the selected worktree snapshot.

The pre-commit hook runs staged and full-source requirement checks, typecheck, unit tests, and build. CI runs base requirement checks and `npm run verify` with Chromium installed; `verify` includes the full-source requirement check.

For Chrome extension debugability work, run `.skills/chrome-extension-debugability/scripts/audit_chrome_extension_debugability.py .` as a source triage pass and run it on `dist/` after `npm run build` when checking the unpacked extension. The root audit reports `background.js` as unreadable because the service worker is a build artifact; inspect `src/background/index.ts` and `dist/background.js` together.

## Requirement Comments

Requirement truth lives in source comments. Use `@behavior`, `@constraint`, and `@intent` for globally unique requirement declarations with one sentence bound to one code unit. A code unit can be a module, type, function, method, branch, state transition, external call, failure path, assertion, or narrower syntax unit. Organize dotted IDs by product or tool requirement domain, then by narrower behavioral detail; a descendant ID expresses a detail of its ancestor next to the code unit that implements that detail. A broad file, type, or function comment covers that code unit only, so inner branches, state transitions, side effects, failure policies, structural abstractions, and test assertions need narrower descendant comments. Public contracts, state policies, durable writes, external calls, observability effects, timeouts, retries, error mapping, access or safety rules, structural abstractions, and test expectations require local requirement comments when they are added or changed. Architecture descriptions, module boundaries, layer duties, helper names, parser roles, loader roles, generator roles, wrapper roles, record shapes, command names, and code-navigation notes belong in ordinary engineering docs or ordinary comments. `@intent` is reserved for an active abstraction boundary whose current business purpose is required by the system. Use `@verifies` as a direct reference whose content is exactly the tag plus an existing `@behavior` or `@constraint` ID, choosing the most specific ID that the test expectation verifies. Search source comments for an ID before changing behavior or structure. The generated requirement index is for retrieval and is updated with `npm run req:fmt-agents` after requirement tag changes.

<!-- BEGIN AGENTS_MD_REQUIREMENT_INDEX -->
[Requirement Index]|root:.
|IMPORTANT: Requirement truth lives in source comments; search source comments for an ID before changing code.
|source:source_comments_only
|declaration_body:single_sentence
|verification_body:tag_plus_existing_id
|binding:one_requirement_comment_per_code_unit
|inner_details:descendant_ids_near_inner_code_units
|tags:{@behavior,@constraint,@intent,@verifies}
|glossa|glossa.{ai_requests,cache_identity,card_creation,extension_contracts,extension_storage,failure_reporting,page_translation,settings_save,shortcuts,translation_start_popup,word_memory}
|glossa.ai_requests|glossa.ai_requests.{backend_interface,failure,glossa_backend,openai,reasoning_effort}
|glossa.ai_requests.backend_interface|glossa.ai_requests.backend_interface.{}
|glossa.ai_requests.failure|glossa.ai_requests.failure.{http_status,invalid_json,request_error,retry_limit,timeout,timeout_cleanup}
|glossa.ai_requests.failure.http_status|glossa.ai_requests.failure.http_status.{}
|glossa.ai_requests.failure.invalid_json|glossa.ai_requests.failure.invalid_json.{}
|glossa.ai_requests.failure.request_error|glossa.ai_requests.failure.request_error.{}
|glossa.ai_requests.failure.retry_limit|glossa.ai_requests.failure.retry_limit.{}
|glossa.ai_requests.failure.timeout|glossa.ai_requests.failure.timeout.{}
|glossa.ai_requests.failure.timeout_cleanup|glossa.ai_requests.failure.timeout_cleanup.{}
|glossa.ai_requests.glossa_backend|glossa.ai_requests.glossa_backend.{anki_card,gloss,gloss_frame}
|glossa.ai_requests.glossa_backend.anki_card|glossa.ai_requests.glossa_backend.anki_card.{}
|glossa.ai_requests.glossa_backend.gloss|glossa.ai_requests.glossa_backend.gloss.{}
|glossa.ai_requests.glossa_backend.gloss_frame|glossa.ai_requests.glossa_backend.gloss_frame.{}
|glossa.ai_requests.openai|glossa.ai_requests.openai.{chat_completions,legacy_completions,responses}
|glossa.ai_requests.openai.chat_completions|glossa.ai_requests.openai.chat_completions.{}
|glossa.ai_requests.openai.legacy_completions|glossa.ai_requests.openai.legacy_completions.{}
|glossa.ai_requests.openai.responses|glossa.ai_requests.openai.responses.{}
|glossa.ai_requests.reasoning_effort|glossa.ai_requests.reasoning_effort.{}
|glossa.cache_identity|glossa.cache_identity.{request_parts,text_hash}
|glossa.cache_identity.request_parts|glossa.cache_identity.request_parts.{}
|glossa.cache_identity.text_hash|glossa.cache_identity.text_hash.{}
|glossa.card_creation|glossa.card_creation.{anki_client,failure,note_request}
|glossa.card_creation.anki_client|glossa.card_creation.anki_client.{}
|glossa.card_creation.failure|glossa.card_creation.failure.{http_status,invalid_response,request_error,service_error}
|glossa.card_creation.failure.http_status|glossa.card_creation.failure.http_status.{}
|glossa.card_creation.failure.invalid_response|glossa.card_creation.failure.invalid_response.{}
|glossa.card_creation.failure.request_error|glossa.card_creation.failure.request_error.{}
|glossa.card_creation.failure.service_error|glossa.card_creation.failure.service_error.{}
|glossa.card_creation.note_request|glossa.card_creation.note_request.{fields,http_call,payload,tags,timeout,timeout_cleanup}
|glossa.card_creation.note_request.fields|glossa.card_creation.note_request.fields.{}
|glossa.card_creation.note_request.http_call|glossa.card_creation.note_request.http_call.{}
|glossa.card_creation.note_request.payload|glossa.card_creation.note_request.payload.{}
|glossa.card_creation.note_request.tags|glossa.card_creation.note_request.tags.{}
|glossa.card_creation.note_request.timeout|glossa.card_creation.note_request.timeout.{}
|glossa.card_creation.note_request.timeout_cleanup|glossa.card_creation.note_request.timeout_cleanup.{}
|glossa.extension_contracts|glossa.extension_contracts.{message_envelopes,payload_consistency,request_effects,restart_continuity}
|glossa.extension_contracts.message_envelopes|glossa.extension_contracts.message_envelopes.{}
|glossa.extension_contracts.payload_consistency|glossa.extension_contracts.payload_consistency.{}
|glossa.extension_contracts.request_effects|glossa.extension_contracts.request_effects.{}
|glossa.extension_contracts.restart_continuity|glossa.extension_contracts.restart_continuity.{}
|glossa.extension_storage|glossa.extension_storage.{typed_access}
|glossa.extension_storage.typed_access|glossa.extension_storage.typed_access.{}
|glossa.failure_reporting|glossa.failure_reporting.{trace_privacy,user_copy}
|glossa.failure_reporting.trace_privacy|glossa.failure_reporting.trace_privacy.{}
|glossa.failure_reporting.user_copy|glossa.failure_reporting.user_copy.{}
|glossa.page_translation|glossa.page_translation.{activation,candidate_scan,inline_rendering,lookup_order,shortcut_selection,token_geometry}
|glossa.page_translation.activation|glossa.page_translation.activation.{}
|glossa.page_translation.candidate_scan|glossa.page_translation.candidate_scan.{}
|glossa.page_translation.inline_rendering|glossa.page_translation.inline_rendering.{}
|glossa.page_translation.lookup_order|glossa.page_translation.lookup_order.{}
|glossa.page_translation.shortcut_selection|glossa.page_translation.shortcut_selection.{}
|glossa.page_translation.token_geometry|glossa.page_translation.token_geometry.{}
|glossa.settings_save|glossa.settings_save.{}
|glossa.shortcuts|glossa.shortcuts.{}
|glossa.translation_start_popup|glossa.translation_start_popup.{}
|glossa.word_memory|glossa.word_memory.{known_word_filter,learning_lifecycle}
|glossa.word_memory.known_word_filter|glossa.word_memory.known_word_filter.{}
|glossa.word_memory.learning_lifecycle|glossa.word_memory.learning_lifecycle.{}
|requirements|requirements.{agent_index,analysis_consistency,change_anchoring,cli,comment_binding,comment_syntax,comment_tree,diagnostic_output,source_snapshot,test_config}
|requirements.agent_index|requirements.agent_index.{default_body,default_insertion,deterministic_rows,freshness,marker_bounds,parent_rows}
|requirements.agent_index.default_body|requirements.agent_index.default_body.{}
|requirements.agent_index.default_insertion|requirements.agent_index.default_insertion.{}
|requirements.agent_index.deterministic_rows|requirements.agent_index.deterministic_rows.{child_buckets}
|requirements.agent_index.deterministic_rows.child_buckets|requirements.agent_index.deterministic_rows.child_buckets.{}
|requirements.agent_index.freshness|requirements.agent_index.freshness.{snapshot_read}
|requirements.agent_index.freshness.snapshot_read|requirements.agent_index.freshness.snapshot_read.{}
|requirements.agent_index.marker_bounds|requirements.agent_index.marker_bounds.{}
|requirements.agent_index.parent_rows|requirements.agent_index.parent_rows.{}
|requirements.analysis_consistency|requirements.analysis_consistency.{comment_facts,cross_file_scope,diagnostic_shape,diff_lines,source_lines,source_text,target_kind_names,target_spans}
|requirements.analysis_consistency.comment_facts|requirements.analysis_consistency.comment_facts.{}
|requirements.analysis_consistency.cross_file_scope|requirements.analysis_consistency.cross_file_scope.{}
|requirements.analysis_consistency.diagnostic_shape|requirements.analysis_consistency.diagnostic_shape.{}
|requirements.analysis_consistency.diff_lines|requirements.analysis_consistency.diff_lines.{current_line,deleted,old_path}
|requirements.analysis_consistency.diff_lines.current_line|requirements.analysis_consistency.diff_lines.current_line.{}
|requirements.analysis_consistency.diff_lines.deleted|requirements.analysis_consistency.diff_lines.deleted.{}
|requirements.analysis_consistency.diff_lines.old_path|requirements.analysis_consistency.diff_lines.old_path.{}
|requirements.analysis_consistency.source_lines|requirements.analysis_consistency.source_lines.{}
|requirements.analysis_consistency.source_text|requirements.analysis_consistency.source_text.{}
|requirements.analysis_consistency.target_kind_names|requirements.analysis_consistency.target_kind_names.{}
|requirements.analysis_consistency.target_spans|requirements.analysis_consistency.target_spans.{}
|requirements.change_anchoring|requirements.change_anchoring.{base_diff,changed_categories,comment_line_skip,current_deletion_anchor,deleted_context,diff_lines,export_modifier,exported_type_members,file_local_lookup,full_source,local_anchor,previous_deletion_anchor,required_tags,rule_names,type_member_changes}
|requirements.change_anchoring.base_diff|requirements.change_anchoring.base_diff.{}
|requirements.change_anchoring.changed_categories|requirements.change_anchoring.changed_categories.{contract,effect,failure,safety,state,structure}
|requirements.change_anchoring.changed_categories.contract|requirements.change_anchoring.changed_categories.contract.{}
|requirements.change_anchoring.changed_categories.effect|requirements.change_anchoring.changed_categories.effect.{}
|requirements.change_anchoring.changed_categories.failure|requirements.change_anchoring.changed_categories.failure.{}
|requirements.change_anchoring.changed_categories.safety|requirements.change_anchoring.changed_categories.safety.{}
|requirements.change_anchoring.changed_categories.state|requirements.change_anchoring.changed_categories.state.{}
|requirements.change_anchoring.changed_categories.structure|requirements.change_anchoring.changed_categories.structure.{}
|requirements.change_anchoring.comment_line_skip|requirements.change_anchoring.comment_line_skip.{standalone_match}
|requirements.change_anchoring.comment_line_skip.standalone_match|requirements.change_anchoring.comment_line_skip.standalone_match.{}
|requirements.change_anchoring.current_deletion_anchor|requirements.change_anchoring.current_deletion_anchor.{}
|requirements.change_anchoring.deleted_context|requirements.change_anchoring.deleted_context.{missing_old_blob}
|requirements.change_anchoring.deleted_context.missing_old_blob|requirements.change_anchoring.deleted_context.missing_old_blob.{}
|requirements.change_anchoring.diff_lines|requirements.change_anchoring.diff_lines.{}
|requirements.change_anchoring.export_modifier|requirements.change_anchoring.export_modifier.{export_keyword,implicit_public}
|requirements.change_anchoring.export_modifier.export_keyword|requirements.change_anchoring.export_modifier.export_keyword.{scan}
|requirements.change_anchoring.export_modifier.export_keyword.scan|requirements.change_anchoring.export_modifier.export_keyword.scan.{}
|requirements.change_anchoring.export_modifier.implicit_public|requirements.change_anchoring.export_modifier.implicit_public.{}
|requirements.change_anchoring.exported_type_members|requirements.change_anchoring.exported_type_members.{}
|requirements.change_anchoring.file_local_lookup|requirements.change_anchoring.file_local_lookup.{bucket}
|requirements.change_anchoring.file_local_lookup.bucket|requirements.change_anchoring.file_local_lookup.bucket.{}
|requirements.change_anchoring.full_source|requirements.change_anchoring.full_source.{lines,required_tags,type_shapes}
|requirements.change_anchoring.full_source.lines|requirements.change_anchoring.full_source.lines.{dedupe}
|requirements.change_anchoring.full_source.lines.dedupe|requirements.change_anchoring.full_source.lines.dedupe.{}
|requirements.change_anchoring.full_source.required_tags|requirements.change_anchoring.full_source.required_tags.{}
|requirements.change_anchoring.full_source.type_shapes|requirements.change_anchoring.full_source.type_shapes.{}
|requirements.change_anchoring.local_anchor|requirements.change_anchoring.local_anchor.{full_source_contract,full_source_owner_span,inner_scope,type_member_target}
|requirements.change_anchoring.local_anchor.full_source_contract|requirements.change_anchoring.local_anchor.full_source_contract.{}
|requirements.change_anchoring.local_anchor.full_source_owner_span|requirements.change_anchoring.local_anchor.full_source_owner_span.{}
|requirements.change_anchoring.local_anchor.inner_scope|requirements.change_anchoring.local_anchor.inner_scope.{broad_declaration_line,exact_target_kinds,structure_test_span,type_alias_span,type_member_span}
|requirements.change_anchoring.local_anchor.inner_scope.broad_declaration_line|requirements.change_anchoring.local_anchor.inner_scope.broad_declaration_line.{}
|requirements.change_anchoring.local_anchor.inner_scope.exact_target_kinds|requirements.change_anchoring.local_anchor.inner_scope.exact_target_kinds.{declaration_list}
|requirements.change_anchoring.local_anchor.inner_scope.exact_target_kinds.declaration_list|requirements.change_anchoring.local_anchor.inner_scope.exact_target_kinds.declaration_list.{}
|requirements.change_anchoring.local_anchor.inner_scope.structure_test_span|requirements.change_anchoring.local_anchor.inner_scope.structure_test_span.{}
|requirements.change_anchoring.local_anchor.inner_scope.type_alias_span|requirements.change_anchoring.local_anchor.inner_scope.type_alias_span.{}
|requirements.change_anchoring.local_anchor.inner_scope.type_member_span|requirements.change_anchoring.local_anchor.inner_scope.type_member_span.{}
|requirements.change_anchoring.local_anchor.type_member_target|requirements.change_anchoring.local_anchor.type_member_target.{}
|requirements.change_anchoring.previous_deletion_anchor|requirements.change_anchoring.previous_deletion_anchor.{}
|requirements.change_anchoring.required_tags|requirements.change_anchoring.required_tags.{}
|requirements.change_anchoring.rule_names|requirements.change_anchoring.rule_names.{}
|requirements.change_anchoring.type_member_changes|requirements.change_anchoring.type_member_changes.{span_match}
|requirements.change_anchoring.type_member_changes.span_match|requirements.change_anchoring.type_member_changes.span_match.{}
|requirements.cli|requirements.cli.{base_check,compare_ref_option,dispatch,full_anchor_check,help,index_check,snapshot_load,snapshot_mode,staged_check}
|requirements.cli.base_check|requirements.cli.base_check.{}
|requirements.cli.compare_ref_option|requirements.cli.compare_ref_option.{}
|requirements.cli.dispatch|requirements.cli.dispatch.{}
|requirements.cli.full_anchor_check|requirements.cli.full_anchor_check.{}
|requirements.cli.help|requirements.cli.help.{usage}
|requirements.cli.help.usage|requirements.cli.help.usage.{}
|requirements.cli.index_check|requirements.cli.index_check.{}
|requirements.cli.snapshot_load|requirements.cli.snapshot_load.{}
|requirements.cli.snapshot_mode|requirements.cli.snapshot_mode.{}
|requirements.cli.staged_check|requirements.cli.staged_check.{}
|requirements.comment_binding|requirements.comment_binding.{adjacency,file_buckets,file_level,first_declaration,target_kinds,target_nodes}
|requirements.comment_binding.adjacency|requirements.comment_binding.adjacency.{}
|requirements.comment_binding.file_buckets|requirements.comment_binding.file_buckets.{}
|requirements.comment_binding.file_level|requirements.comment_binding.file_level.{}
|requirements.comment_binding.first_declaration|requirements.comment_binding.first_declaration.{}
|requirements.comment_binding.target_kinds|requirements.comment_binding.target_kinds.{}
|requirements.comment_binding.target_nodes|requirements.comment_binding.target_nodes.{target_facts,walk}
|requirements.comment_binding.target_nodes.target_facts|requirements.comment_binding.target_nodes.target_facts.{}
|requirements.comment_binding.target_nodes.walk|requirements.comment_binding.target_nodes.walk.{}
|requirements.comment_syntax|requirements.comment_syntax.{declaration_sentence,discovery,normalization}
|requirements.comment_syntax.declaration_sentence|requirements.comment_syntax.declaration_sentence.{}
|requirements.comment_syntax.discovery|requirements.comment_syntax.discovery.{dedupe}
|requirements.comment_syntax.discovery.dedupe|requirements.comment_syntax.discovery.dedupe.{}
|requirements.comment_syntax.normalization|requirements.comment_syntax.normalization.{}
|requirements.comment_tree|requirements.comment_tree.{repository_scope,unique_ids,validation}
|requirements.comment_tree.repository_scope|requirements.comment_tree.repository_scope.{}
|requirements.comment_tree.unique_ids|requirements.comment_tree.unique_ids.{}
|requirements.comment_tree.validation|requirements.comment_tree.validation.{declared_ancestors,leaf_coverage,test_references,verified_id_set}
|requirements.comment_tree.validation.declared_ancestors|requirements.comment_tree.validation.declared_ancestors.{}
|requirements.comment_tree.validation.leaf_coverage|requirements.comment_tree.validation.leaf_coverage.{}
|requirements.comment_tree.validation.test_references|requirements.comment_tree.validation.test_references.{}
|requirements.comment_tree.validation.verified_id_set|requirements.comment_tree.validation.verified_id_set.{}
|requirements.diagnostic_output|requirements.diagnostic_output.{comment_locations,compiler_style,line_numbers,portable_paths,scan_listing}
|requirements.diagnostic_output.comment_locations|requirements.diagnostic_output.comment_locations.{}
|requirements.diagnostic_output.compiler_style|requirements.diagnostic_output.compiler_style.{stderr}
|requirements.diagnostic_output.compiler_style.stderr|requirements.diagnostic_output.compiler_style.stderr.{}
|requirements.diagnostic_output.line_numbers|requirements.diagnostic_output.line_numbers.{}
|requirements.diagnostic_output.portable_paths|requirements.diagnostic_output.portable_paths.{}
|requirements.diagnostic_output.scan_listing|requirements.diagnostic_output.scan_listing.{rows}
|requirements.diagnostic_output.scan_listing.rows|requirements.diagnostic_output.scan_listing.rows.{}
|requirements.source_snapshot|requirements.source_snapshot.{git_reads,source_scope,staged,staged_dispatch,worktree}
|requirements.source_snapshot.git_reads|requirements.source_snapshot.git_reads.{}
|requirements.source_snapshot.source_scope|requirements.source_snapshot.source_scope.{}
|requirements.source_snapshot.staged|requirements.source_snapshot.staged.{missing_blobs}
|requirements.source_snapshot.staged.missing_blobs|requirements.source_snapshot.staged.missing_blobs.{}
|requirements.source_snapshot.staged_dispatch|requirements.source_snapshot.staged_dispatch.{}
|requirements.source_snapshot.worktree|requirements.source_snapshot.worktree.{}
|requirements.test_config|requirements.test_config.{browser}
|requirements.test_config.browser|requirements.test_config.browser.{}
<!-- END AGENTS_MD_REQUIREMENT_INDEX -->
