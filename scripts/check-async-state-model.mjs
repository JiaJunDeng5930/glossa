const transition = (to, effect = "none") => ({ to, effect });

function row(state, events, overrides = {}, defaultEffect = "ignore") {
  return Object.fromEntries(events.map((event) => [
    event,
    overrides[event] ?? transition(state, defaultEffect)
  ]));
}

function closedRow(events) {
  return row("closed", events);
}

const normalizers = [
  {
    name: "operation-result",
    domains: { current: [false, true] },
    rules: [
      { event: "RESULT_CURRENT", when: ({ current }) => current },
      { event: "RESULT_STALE", when: ({ current }) => !current }
    ]
  },
  {
    name: "desired-key",
    domains: { same: [false, true] },
    rules: [
      { event: "START_SAME", when: ({ same }) => same },
      { event: "START_NEW", when: ({ same }) => !same }
    ]
  },
  {
    name: "port-start",
    domains: { schemaValid: [false, true], hashMatch: [false, true] },
    rules: [
      { event: "START_INVALID", when: ({ schemaValid }) => !schemaValid },
      { event: "START_OBSOLETE", when: ({ schemaValid, hashMatch }) => schemaValid && !hashMatch },
      { event: "START_VALID", when: ({ schemaValid, hashMatch }) => schemaValid && hashMatch }
    ]
  },
  {
    name: "port-chunk",
    domains: { scanMatch: [false, true], indexMatch: [false, true], idNew: [false, true] },
    rules: [
      { event: "CHUNK_VALID", when: ({ scanMatch, indexMatch, idNew }) => scanMatch && indexMatch && idNew },
      { event: "CHUNK_INVALID", when: ({ scanMatch, indexMatch, idNew }) => !(scanMatch && indexMatch && idNew) }
    ]
  },
  {
    name: "scan-retire",
    domains: { source: ["dom-mutation", "new-scan", "route", "generation", "translation-off", "stop"] },
    rules: [
      { event: "SOFT_RETIRE", when: ({ source }) => ["dom-mutation", "new-scan"].includes(source) },
      { event: "HARD_RETIRE", when: ({ source }) => ["route", "generation", "translation-off", "stop"].includes(source) }
    ]
  },
  {
    name: "cache-completion",
    domains: { current: [false, true] },
    rules: [
      { event: "CLEAR_DONE_CURRENT", when: ({ current }) => current },
      { event: "CLEAR_DONE_STALE", when: ({ current }) => !current }
    ]
  },
  {
    name: "lexicon-expiry",
    domains: { finite: [false, true], future: [false, true] },
    rules: [
      { event: "EXPIRE_FUTURE", when: ({ finite, future }) => finite && future },
      { event: "EXPIRE_DUE_OR_INVALID", when: ({ finite, future }) => !(finite && future) }
    ]
  },
  {
    name: "anki-failure",
    domains: { kind: ["http", "anki-error", "timeout", "network", "parse", "owner-stop"] },
    rules: [
      { event: "ANKI_DEFINITE_FAILED", when: ({ kind }) => ["http", "anki-error"].includes(kind) },
      { event: "ANKI_UNKNOWN", when: ({ kind }) => ["timeout", "network", "parse", "owner-stop"].includes(kind) }
    ]
  },
  {
    name: "save-completion",
    domains: { current: [false, true], revisionSame: [false, true] },
    rules: [
      { event: "RESULT_STALE", when: ({ current }) => !current },
      { event: "SAVE_OK_UNCHANGED", when: ({ current, revisionSame }) => current && revisionSame },
      { event: "SAVE_OK_CHANGED", when: ({ current, revisionSame }) => current && !revisionSame }
    ]
  },
  {
    name: "reset-request",
    domains: { activeZero: [false, true] },
    rules: [
      { event: "RESET_IDLE", when: ({ activeZero }) => activeZero },
      { event: "RESET_BUSY", when: ({ activeZero }) => !activeZero }
    ]
  },
  {
    name: "card-completion-count",
    domains: { activeCount: [0, 1, 2] },
    rules: [
      { event: "CARD_DONE_INVALID", when: ({ activeCount }) => activeCount === 0 },
      { event: "CARD_DONE_LAST", when: ({ activeCount }) => activeCount === 1 },
      { event: "CARD_DONE_MORE", when: ({ activeCount }) => activeCount > 1 }
    ]
  },
  {
    name: "shortcut-keydown",
    domains: { translationMatch: [false, true], repeat: [false, true], holdMatch: [false, true] },
    rules: [
      { event: "KEYDOWN_TRANSLATE_FIRST", when: ({ translationMatch, repeat }) => translationMatch && !repeat },
      { event: "KEYDOWN_TRANSLATE_REPEAT", when: ({ translationMatch, repeat }) => translationMatch && repeat },
      { event: "KEYDOWN_HOLD", when: ({ translationMatch, holdMatch }) => !translationMatch && holdMatch },
      { event: "KEYDOWN_OTHER", when: ({ translationMatch, holdMatch }) => !translationMatch && !holdMatch }
    ]
  },
  {
    name: "shortcut-capture-conflict",
    domains: { conflicts: [false, true] },
    rules: [
      { event: "FINISH_VALID", when: ({ conflicts }) => !conflicts },
      { event: "FINISH_CONFLICT", when: ({ conflicts }) => conflicts }
    ]
  }
];

const machines = [
  defineMachine({
    name: "content-runtime",
    initial: "booting",
    states: ["booting", "enabled", "disabled", "closed"],
    observations: {
      booting: "starting",
      enabled: "translation-on",
      disabled: "translation-off",
      closed: "absent"
    },
    events: [
      "BOOT_READY_ON", "BOOT_READY_OFF", "BOOT_FAILED", "GET", "SET_ON", "SET_OFF", "TOGGLE",
      "SETTINGS_COMPATIBLE", "SETTINGS_RELOAD_WORDLIST", "ROUTE_TO_ON", "ROUTE_TO_OFF", "STOP"
    ],
    build(events) {
      return {
        booting: row("booting", events, {
          BOOT_READY_ON: transition("enabled", "publish-ready-and-scan"),
          BOOT_READY_OFF: transition("disabled", "publish-ready"),
          BOOT_FAILED: transition("closed", "publish-startup-error-and-clean"),
          GET: transition("booting", "reply-booting"),
          SET_ON: transition("booting", "reply-booting"),
          SET_OFF: transition("booting", "reply-booting"),
          TOGGLE: transition("booting", "reply-booting"),
          SETTINGS_COMPATIBLE: transition("booting", "replace-desired-snapshot"),
          SETTINGS_RELOAD_WORDLIST: transition("booting", "replace-desired-snapshot-and-load"),
          ROUTE_TO_ON: transition("booting", "replace-route-default"),
          ROUTE_TO_OFF: transition("booting", "replace-route-default"),
          STOP: transition("closed", "clean")
        }),
        enabled: row("enabled", events, {
          GET: transition("enabled", "reply-on"),
          SET_ON: transition("enabled", "reply-on"),
          SET_OFF: transition("disabled", "retire-hard-unrender-broadcast-off"),
          TOGGLE: transition("disabled", "retire-hard-unrender-broadcast-off"),
          SETTINGS_COMPATIBLE: transition("enabled", "commit-snapshot-retire-and-scan-if-generation-changed"),
          SETTINGS_RELOAD_WORDLIST: transition("enabled", "start-wordlist-load"),
          ROUTE_TO_ON: transition("enabled", "retire-route-and-scan"),
          ROUTE_TO_OFF: transition("disabled", "retire-route-unrender-broadcast-off"),
          STOP: transition("closed", "retire-hard-unrender-clean")
        }),
        disabled: row("disabled", events, {
          GET: transition("disabled", "reply-off"),
          SET_ON: transition("enabled", "broadcast-on-and-scan"),
          SET_OFF: transition("disabled", "reply-off"),
          TOGGLE: transition("enabled", "broadcast-on-and-scan"),
          SETTINGS_COMPATIBLE: transition("disabled", "commit-snapshot"),
          SETTINGS_RELOAD_WORDLIST: transition("disabled", "start-wordlist-load"),
          ROUTE_TO_ON: transition("enabled", "retire-route-broadcast-on-and-scan"),
          ROUTE_TO_OFF: transition("disabled", "retire-route"),
          STOP: transition("closed", "clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "replaceable-task",
    initial: "stable",
    states: ["stable", "loading", "closed"],
    observations: { stable: "usable", loading: "waiting", closed: "absent" },
    events: ["START_SAME", "START_NEW", "RESULT_CURRENT_OK", "RESULT_CURRENT_ERROR", "RESULT_STALE", "STOP"],
    build(events) {
      return {
        stable: row("stable", events, {
          START_NEW: transition("loading", "start-current-operation"),
          RESULT_CURRENT_OK: transition("stable", "ignore-impossible-result"),
          RESULT_CURRENT_ERROR: transition("stable", "ignore-impossible-result"),
          RESULT_STALE: transition("stable", "ignore-stale-result"),
          STOP: transition("closed", "clean")
        }),
        loading: row("loading", events, {
          START_SAME: transition("loading", "keep-current-operation"),
          START_NEW: transition("loading", "retire-old-and-start-new"),
          RESULT_CURRENT_OK: transition("stable", "commit-current-result"),
          RESULT_CURRENT_ERROR: transition("stable", "commit-current-fallback-or-error"),
          RESULT_STALE: transition("loading", "ignore-stale-result"),
          STOP: transition("closed", "retire-and-clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "latest-ui-task",
    initial: "idle",
    states: ["idle", "pending", "closed"],
    observations: { idle: "controls-enabled", pending: "latest-operation-pending", closed: "absent" },
    events: ["START", "RESULT_CURRENT_OK", "RESULT_CURRENT_ERROR", "RESULT_STALE", "CLOSE"],
    build(events) {
      return {
        idle: row("idle", events, {
          START: transition("pending", "capture-key-and-start"),
          RESULT_CURRENT_OK: transition("idle", "ignore-impossible-result"),
          RESULT_CURRENT_ERROR: transition("idle", "ignore-impossible-result"),
          RESULT_STALE: transition("idle", "ignore-stale-result"),
          CLOSE: transition("closed", "clean")
        }),
        pending: row("pending", events, {
          START: transition("pending", "retire-old-and-start-latest"),
          RESULT_CURRENT_OK: transition("idle", "commit-current-result"),
          RESULT_CURRENT_ERROR: transition("idle", "show-current-error"),
          RESULT_STALE: transition("pending", "ignore-stale-result"),
          CLOSE: transition("closed", "retire-and-clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "shortcut-coordinator",
    initial: "idle",
    states: ["idle", "held", "closed"],
    observations: { idle: "page-input-normal", held: "selection-mode", closed: "absent" },
    events: [
      "KEYDOWN_HOLD", "KEYDOWN_TRANSLATE_FIRST", "KEYDOWN_TRANSLATE_REPEAT", "KEYDOWN_OTHER",
      "KEYUP_HOLD", "KEYUP_OTHER", "CLICK_WORD", "CLICK_OTHER", "PAGE_INPUT", "FOCUS_LOST",
      "SHORTCUT_CHANGED", "DETACH"
    ],
    build(events) {
      return {
        idle: row("idle", events, {
          KEYDOWN_HOLD: transition("held", "consume-and-enter-selection"),
          KEYDOWN_TRANSLATE_FIRST: transition("idle", "consume-and-toggle-translation"),
          KEYDOWN_TRANSLATE_REPEAT: transition("idle", "consume-without-toggle"),
          FOCUS_LOST: transition("idle", "ignore-focus-loss"),
          SHORTCUT_CHANGED: transition("idle", "replace-bindings"),
          DETACH: transition("closed", "clean")
        }, "pass-through"),
        held: row("held", events, {
          KEYDOWN_HOLD: transition("held", "consume-repeat"),
          KEYDOWN_TRANSLATE_FIRST: transition("idle", "exit-selection-consume-and-toggle"),
          KEYDOWN_TRANSLATE_REPEAT: transition("idle", "exit-selection-consume-without-toggle"),
          KEYDOWN_OTHER: transition("idle", "exit-selection-and-pass-through"),
          KEYUP_HOLD: transition("idle", "consume-and-exit-selection"),
          KEYUP_OTHER: transition("held", "consume"),
          CLICK_WORD: transition("held", "consume-and-select-word"),
          CLICK_OTHER: transition("held", "consume"),
          PAGE_INPUT: transition("held", "consume"),
          FOCUS_LOST: transition("idle", "exit-selection"),
          SHORTCUT_CHANGED: transition("idle", "exit-selection-and-replace-bindings"),
          DETACH: transition("closed", "exit-selection-and-clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "scan-attempt",
    initial: "collecting",
    states: ["collecting", "active", "retired", "closed"],
    observations: { collecting: "pending", active: "pending", retired: "pending", closed: "terminal" },
    events: [
      "OUTCOME", "DOM_DONE_WITH_SESSION", "DOM_DONE_EMPTY", "ACK_KNOWN", "ACK_UNKNOWN",
      "BACKGROUND_DONE", "SOFT_RETIRE", "HARD_RETIRE", "TERMINAL_ERROR"
    ],
    build(events) {
      return {
        collecting: row("collecting", events, {
          OUTCOME: transition("collecting", "queue-on-attempt"),
          DOM_DONE_WITH_SESSION: transition("active", "flush-queue-and-send-end"),
          DOM_DONE_EMPTY: transition("closed", "finish-empty"),
          ACK_KNOWN: transition("collecting", "resolve-ack-once"),
          ACK_UNKNOWN: transition("collecting", "ignore-unknown-ack"),
          BACKGROUND_DONE: transition("closed", "protocol-error-and-finalize-pending"),
          SOFT_RETIRE: transition("retired", "abort-producer-and-end-sent-prefix"),
          HARD_RETIRE: transition("closed", "disconnect-drop-and-clean"),
          TERMINAL_ERROR: transition("closed", "disconnect-and-finalize-pending-error")
        }),
        active: row("active", events, {
          OUTCOME: transition("active", "apply-current-outcome"),
          DOM_DONE_WITH_SESSION: transition("closed", "protocol-error-and-finalize-pending"),
          DOM_DONE_EMPTY: transition("closed", "protocol-error-and-finalize-pending"),
          ACK_KNOWN: transition("active", "resolve-ack-once"),
          ACK_UNKNOWN: transition("active", "ignore-unknown-ack"),
          BACKGROUND_DONE: transition("closed", "finalize-pending-and-clean"),
          SOFT_RETIRE: transition("retired", "keep-port-for-matching-pending-only"),
          HARD_RETIRE: transition("closed", "disconnect-drop-and-clean"),
          TERMINAL_ERROR: transition("closed", "disconnect-and-finalize-pending-error")
        }),
        retired: row("retired", events, {
          OUTCOME: transition("retired", "reconcile-matching-pending-only"),
          DOM_DONE_WITH_SESSION: transition("retired", "ignore-retired-producer"),
          DOM_DONE_EMPTY: transition("retired", "ignore-retired-producer"),
          ACK_KNOWN: transition("retired", "resolve-ack-once"),
          ACK_UNKNOWN: transition("retired", "ignore-unknown-ack"),
          BACKGROUND_DONE: transition("closed", "finalize-retired-and-clean"),
          SOFT_RETIRE: transition("retired", "ignore-already-retired"),
          HARD_RETIRE: transition("closed", "disconnect-drop-and-clean"),
          TERMINAL_ERROR: transition("closed", "disconnect-and-finalize-pending-error")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "occurrence-feedback",
    initial: "gloss",
    states: ["gloss", "card-pending", "card-success", "card-error", "card-unknown", "closed"],
    observations: {
      gloss: "gloss-result",
      "card-pending": "card-pending-badge",
      "card-success": "card-success-badge",
      "card-error": "card-error-badge",
      "card-unknown": "card-unknown-badge",
      closed: "absent"
    },
    events: ["GLOSS_UPDATE", "CARD_START", "CARD_SUCCESS", "CARD_ERROR", "CARD_UNKNOWN", "FEEDBACK_EXPIRED", "REMOVE"],
    build(events) {
      const terminalCardRow = (state) => row(state, events, {
        GLOSS_UPDATE: transition(state, "update-gloss-underlay"),
        CARD_START: transition("card-pending", "replace-feedback-with-pending"),
        CARD_SUCCESS: transition(state, "ignore-stale-card-result"),
        CARD_ERROR: transition(state, "ignore-stale-card-result"),
        CARD_UNKNOWN: transition(state, "ignore-stale-card-result"),
        FEEDBACK_EXPIRED: transition("gloss", "reveal-current-gloss"),
        REMOVE: transition("closed", "remove")
      });
      return {
        gloss: row("gloss", events, {
          GLOSS_UPDATE: transition("gloss", "render-gloss"),
          CARD_START: transition("card-pending", "render-card-pending"),
          CARD_SUCCESS: transition("gloss", "ignore-stale-card-result"),
          CARD_ERROR: transition("gloss", "ignore-stale-card-result"),
          CARD_UNKNOWN: transition("gloss", "ignore-stale-card-result"),
          FEEDBACK_EXPIRED: transition("gloss", "ignore-no-feedback"),
          REMOVE: transition("closed", "remove")
        }),
        "card-pending": row("card-pending", events, {
          GLOSS_UPDATE: transition("card-pending", "update-gloss-underlay"),
          CARD_START: transition("card-pending", "reuse-pending-operation"),
          CARD_SUCCESS: transition("card-success", "render-card-success"),
          CARD_ERROR: transition("card-error", "render-card-error"),
          CARD_UNKNOWN: transition("card-unknown", "render-card-unknown"),
          FEEDBACK_EXPIRED: transition("card-pending", "ignore-before-terminal"),
          REMOVE: transition("closed", "remove")
        }),
        "card-success": terminalCardRow("card-success"),
        "card-error": terminalCardRow("card-error"),
        "card-unknown": terminalCardRow("card-unknown"),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "gloss-port",
    initial: "waiting",
    states: ["waiting", "open", "finishing", "closed"],
    observations: {
      waiting: "protocol-live",
      open: "protocol-live",
      finishing: "protocol-draining",
      closed: "protocol-closed"
    },
    events: [
      "START_VALID", "START_OBSOLETE", "START_INVALID", "CHUNK_VALID", "CHUNK_INVALID", "END",
      "MESSAGE_INVALID", "LOOKUP_OUTCOME", "FINISH_OK", "FINISH_ERROR", "DISCONNECT", "INTERNAL_ERROR"
    ],
    build(events) {
      const protocolFailure = Object.fromEntries(events.map((event) => [event, transition("closed", "emit-protocol-error-and-clean")]));
      return {
        waiting: {
          ...protocolFailure,
          START_VALID: transition("open", "capture-snapshot"),
          START_OBSOLETE: transition("closed", "emit-obsolete-and-clean"),
          DISCONNECT: transition("closed", "clean"),
          INTERNAL_ERROR: transition("closed", "emit-internal-error-and-clean")
        },
        open: {
          ...protocolFailure,
          CHUNK_VALID: transition("open", "register-lookup-then-ack-once"),
          LOOKUP_OUTCOME: transition("open", "emit-token-outcome"),
          END: transition("finishing", "stop-input-and-await-lookups"),
          DISCONNECT: transition("closed", "cancel-subscription-and-clean"),
          INTERNAL_ERROR: transition("closed", "emit-internal-error-and-clean")
        },
        finishing: {
          ...protocolFailure,
          LOOKUP_OUTCOME: transition("finishing", "emit-token-outcome"),
          FINISH_OK: transition("closed", "emit-done-and-clean"),
          FINISH_ERROR: transition("closed", "emit-internal-error-and-clean"),
          DISCONNECT: transition("closed", "cancel-subscription-and-clean"),
          INTERNAL_ERROR: transition("closed", "emit-internal-error-and-clean")
        },
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "generation-cache",
    initial: "ready",
    states: ["ready", "clearing", "closed"],
    observations: { ready: "cache-usable", clearing: "clear-in-progress", closed: "absent" },
    events: [
      "ACTIVATE_SAME", "ACTIVATE_CHANGED", "CLEAR", "CLEAR_DONE_CURRENT_OK", "CLEAR_DONE_CURRENT_ERROR",
      "CLEAR_DONE_STALE", "SESSION_START", "PUT_CURRENT", "PUT_STALE", "STOP"
    ],
    build(events) {
      return {
        ready: row("ready", events, {
          ACTIVATE_CHANGED: transition("ready", "bump-epoch-abort-old-and-clear-memory"),
          CLEAR: transition("clearing", "bump-epoch-abort-old-clear-memory-and-enqueue-clear"),
          CLEAR_DONE_CURRENT_OK: transition("ready", "ignore-impossible-completion"),
          CLEAR_DONE_CURRENT_ERROR: transition("ready", "ignore-impossible-completion"),
          CLEAR_DONE_STALE: transition("ready", "ignore-stale-completion"),
          SESSION_START: transition("ready", "capture-current-epoch"),
          PUT_CURRENT: transition("ready", "enqueue-put-on-cache-lane"),
          PUT_STALE: transition("ready", "drop-stale-put"),
          STOP: transition("closed", "abort-and-clean")
        }),
        clearing: row("clearing", events, {
          ACTIVATE_SAME: transition("clearing", "keep-clear-barrier"),
          ACTIVATE_CHANGED: transition("clearing", "bump-epoch-abort-old-clear-memory-and-keep-barrier"),
          CLEAR: transition("clearing", "coalesce-clear"),
          CLEAR_DONE_CURRENT_OK: transition("ready", "publish-clear-success"),
          CLEAR_DONE_CURRENT_ERROR: transition("ready", "publish-clear-error"),
          CLEAR_DONE_STALE: transition("clearing", "ignore-stale-completion"),
          SESSION_START: transition("clearing", "wait-barrier-then-capture-current-epoch"),
          PUT_CURRENT: transition("clearing", "enqueue-put-after-clear"),
          PUT_STALE: transition("clearing", "drop-stale-put"),
          STOP: transition("closed", "abort-and-clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "vocabulary-record",
    initial: "missing",
    states: ["missing", "known", "learning", "ignored"],
    observations: { missing: "eligible", known: "hidden", learning: "shown-during-window", ignored: "hidden-by-user" },
    events: ["SHOWN", "CARD_CREATED", "EXPIRE_FUTURE", "EXPIRE_DUE_OR_INVALID", "MARK_KNOWN", "IGNORE", "REMOVE_KNOWN"],
    build(events) {
      return {
        missing: row("missing", events, {
          SHOWN: transition("known", "create-known-with-one-show"),
          CARD_CREATED: transition("learning", "create-learning-and-card-marker"),
          MARK_KNOWN: transition("known", "create-known"),
          IGNORE: transition("ignored", "create-ignored")
        }),
        known: row("known", events, {
          SHOWN: transition("known", "increment-show-count"),
          CARD_CREATED: transition("learning", "extend-window-and-merge-card-marker"),
          MARK_KNOWN: transition("known", "keep-known"),
          IGNORE: transition("ignored", "replace-with-ignored"),
          REMOVE_KNOWN: transition("missing", "delete-known")
        }),
        learning: row("learning", events, {
          SHOWN: transition("learning", "increment-show-count"),
          CARD_CREATED: transition("learning", "extend-window-and-merge-card-marker"),
          EXPIRE_FUTURE: transition("learning", "keep-learning"),
          EXPIRE_DUE_OR_INVALID: transition("known", "settle-known"),
          MARK_KNOWN: transition("known", "settle-known"),
          IGNORE: transition("ignored", "replace-with-ignored")
        }),
        ignored: row("ignored", events, {
          SHOWN: transition("ignored", "ignore-late-show"),
          CARD_CREATED: transition("learning", "explicit-card-overrides-ignore"),
          MARK_KNOWN: transition("known", "replace-with-known"),
          IGNORE: transition("ignored", "keep-ignored")
        })
      };
    }
  }),
  defineMachine({
    name: "card-operation",
    initial: "checking",
    states: ["checking", "generating", "adding", "recording", "closed"],
    observations: { checking: "pending", generating: "pending", adding: "pending", recording: "pending", closed: "terminal" },
    events: [
      "PROCEED", "DUPLICATE_REQUIRED", "AI_ONE", "AI_INVALID", "AI_FAILED", "ANKI_OK",
      "ANKI_DEFINITE_FAILED", "ANKI_UNKNOWN", "LOCAL_OK", "LOCAL_FAILED", "OWNER_STOP", "INTERNAL_ERROR"
    ],
    build(events) {
      const failBeforeCommit = Object.fromEntries(events.map((event) => [event, transition("closed", "emit-failed-before-commit")]));
      return {
        checking: {
          ...failBeforeCommit,
          PROCEED: transition("generating", "start-or-read-one-card-content"),
          DUPLICATE_REQUIRED: transition("closed", "request-duplicate-confirmation"),
          OWNER_STOP: transition("closed", "emit-failed-before-commit")
        },
        generating: {
          ...failBeforeCommit,
          AI_ONE: transition("adding", "send-one-add-note"),
          AI_INVALID: transition("closed", "emit-invalid-card-content"),
          AI_FAILED: transition("closed", "emit-failed-before-commit"),
          OWNER_STOP: transition("closed", "emit-failed-before-commit")
        },
        adding: {
          ...failBeforeCommit,
          ANKI_OK: transition("recording", "capture-note-id"),
          ANKI_DEFINITE_FAILED: transition("closed", "emit-failed-before-commit"),
          ANKI_UNKNOWN: transition("closed", "emit-outcome-unknown"),
          OWNER_STOP: transition("closed", "emit-outcome-unknown"),
          INTERNAL_ERROR: transition("closed", "emit-outcome-unknown")
        },
        recording: {
          ...failBeforeCommit,
          LOCAL_OK: transition("closed", "emit-success"),
          LOCAL_FAILED: transition("closed", "emit-success-and-local-diagnostic"),
          OWNER_STOP: transition("closed", "emit-success-and-local-diagnostic"),
          INTERNAL_ERROR: transition("closed", "emit-success-and-local-diagnostic")
        },
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "card-reset-barrier",
    initial: "open",
    states: ["open", "draining", "resetting", "closed"],
    observations: { open: "card-commands-admitted", draining: "reset-pending", resetting: "reset-pending", closed: "absent" },
    events: [
      "CARD_START", "CARD_DONE_MORE", "CARD_DONE_LAST", "CARD_DONE_INVALID", "RESET_IDLE", "RESET_BUSY",
      "CLEAR_OK", "CLEAR_FAILED", "STOP"
    ],
    build(events) {
      return {
        open: row("open", events, {
          CARD_START: transition("open", "increment-active-and-start-card"),
          CARD_DONE_MORE: transition("open", "decrement-active"),
          CARD_DONE_LAST: transition("open", "decrement-active-to-zero"),
          CARD_DONE_INVALID: transition("closed", "emit-accounting-error-and-reject-queued"),
          RESET_IDLE: transition("resetting", "block-new-and-start-clear"),
          RESET_BUSY: transition("draining", "block-new-and-wait-active"),
          CLEAR_OK: transition("open", "ignore-impossible-completion"),
          CLEAR_FAILED: transition("open", "ignore-impossible-completion"),
          STOP: transition("closed", "reject-queued-and-clean")
        }),
        draining: row("draining", events, {
          CARD_START: transition("draining", "queue-behind-reset"),
          CARD_DONE_MORE: transition("draining", "decrement-active"),
          CARD_DONE_LAST: transition("resetting", "decrement-active-to-zero-and-start-clear"),
          CARD_DONE_INVALID: transition("closed", "emit-accounting-error-and-reject-queued"),
          RESET_IDLE: transition("draining", "coalesce-reset"),
          RESET_BUSY: transition("draining", "coalesce-reset"),
          CLEAR_OK: transition("draining", "ignore-impossible-completion"),
          CLEAR_FAILED: transition("draining", "ignore-impossible-completion"),
          STOP: transition("closed", "reject-queued-and-clean")
        }),
        resetting: row("resetting", events, {
          CARD_START: transition("resetting", "queue-behind-reset"),
          CARD_DONE_MORE: transition("closed", "emit-accounting-error-and-reject-queued"),
          CARD_DONE_LAST: transition("closed", "emit-accounting-error-and-reject-queued"),
          CARD_DONE_INVALID: transition("closed", "emit-accounting-error-and-reject-queued"),
          RESET_IDLE: transition("resetting", "coalesce-reset"),
          RESET_BUSY: transition("resetting", "coalesce-reset"),
          CLEAR_OK: transition("open", "publish-success-and-release-queued"),
          CLEAR_FAILED: transition("open", "publish-error-and-release-queued"),
          STOP: transition("closed", "reject-queued-and-clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "duplicate-prompt",
    initial: "closed",
    states: ["closed", "open"],
    observations: { closed: "absent", open: "confirmation-visible" },
    events: ["OPEN", "CONFIRM", "CANCEL", "TIMEOUT", "OWNER_CLOSE"],
    build(events) {
      return {
        closed: row("closed", events, { OPEN: transition("open", "render-focus-and-arm-timer") }),
        open: row("open", events, {
          OPEN: transition("open", "resolve-old-no-clean-and-open-new"),
          CONFIRM: transition("closed", "resolve-yes-and-clean"),
          CANCEL: transition("closed", "resolve-no-and-clean"),
          TIMEOUT: transition("closed", "resolve-no-and-clean"),
          OWNER_CLOSE: transition("closed", "resolve-no-and-clean")
        })
      };
    }
  }),
  defineMachine({
    name: "settings-document",
    initial: "loading",
    states: ["loading", "ready", "failed", "closed"],
    observations: { loading: "inert-loading", ready: "editable", failed: "inert-error", closed: "absent" },
    events: ["LOAD_OK", "LOAD_FAILED", "RETRY", "CLOSE"],
    build(events) {
      return {
        loading: row("loading", events, {
          LOAD_OK: transition("ready", "populate-once-and-remove-inert"),
          LOAD_FAILED: transition("failed", "show-load-error"),
          CLOSE: transition("closed", "clean")
        }),
        ready: row("ready", events, { CLOSE: transition("closed", "clean") }),
        failed: row("failed", events, {
          RETRY: transition("loading", "start-new-load"),
          CLOSE: transition("closed", "clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "settings-save",
    initial: "clean",
    states: ["clean", "dirty", "saving", "error", "closed"],
    observations: { clean: "saved", dirty: "unsaved", saving: "saving", error: "save-error", closed: "absent" },
    events: ["INPUT", "SAVE", "SAVE_OK_UNCHANGED", "SAVE_OK_CHANGED", "SAVE_FAILED", "RESULT_STALE", "CLOSE"],
    build(events) {
      return {
        clean: row("clean", events, {
          INPUT: transition("dirty", "increment-draft-revision"),
          SAVE: transition("saving", "capture-snapshot-and-revision"),
          CLOSE: transition("closed", "clean")
        }),
        dirty: row("dirty", events, {
          INPUT: transition("dirty", "increment-draft-revision"),
          SAVE: transition("saving", "capture-snapshot-and-revision"),
          CLOSE: transition("closed", "clean")
        }),
        saving: row("saving", events, {
          INPUT: transition("saving", "increment-draft-revision"),
          SAVE: transition("saving", "ignore-duplicate-save"),
          SAVE_OK_UNCHANGED: transition("clean", "show-saved"),
          SAVE_OK_CHANGED: transition("dirty", "show-saved-older-snapshot"),
          SAVE_FAILED: transition("error", "show-save-error"),
          RESULT_STALE: transition("saving", "ignore-stale-result"),
          CLOSE: transition("closed", "retire-and-clean")
        }),
        error: row("error", events, {
          INPUT: transition("dirty", "increment-draft-revision-and-clear-error"),
          SAVE: transition("saving", "capture-snapshot-and-revision"),
          CLOSE: transition("closed", "clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "exclusive-ui-task",
    initial: "idle",
    states: ["idle", "pending", "closed"],
    observations: { idle: "controls-enabled", pending: "controls-disabled", closed: "absent" },
    events: ["START", "RESULT_OK", "RESULT_ERROR", "CLOSE"],
    build(events) {
      return {
        idle: row("idle", events, {
          START: transition("pending", "disable-and-start"),
          CLOSE: transition("closed", "clean")
        }),
        pending: row("pending", events, {
          START: transition("pending", "ignore-duplicate-start"),
          RESULT_OK: transition("idle", "commit-refresh-and-enable"),
          RESULT_ERROR: transition("idle", "show-error-and-enable"),
          CLOSE: transition("closed", "retire-and-clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "shortcut-capture",
    initial: "idle",
    states: ["idle", "capturing", "closed"],
    observations: { idle: "capture-buttons-ready", capturing: "waiting-for-shortcut", closed: "absent" },
    events: ["START", "MODIFIER_DOWN", "FINISH_VALID", "FINISH_CONFLICT", "CLOSE"],
    build(events) {
      return {
        idle: row("idle", events, {
          START: transition("capturing", "capture-target-and-focus"),
          CLOSE: transition("closed", "clean")
        }),
        capturing: row("capturing", events, {
          START: transition("capturing", "replace-target-and-reset-pending"),
          MODIFIER_DOWN: transition("capturing", "update-pending-and-consume"),
          FINISH_VALID: transition("idle", "commit-shortcut-mark-dirty-and-consume"),
          FINISH_CONFLICT: transition("capturing", "show-inline-conflict-and-consume"),
          CLOSE: transition("closed", "clean")
        }),
        closed: closedRow(events)
      };
    }
  }),
  defineMachine({
    name: "popup",
    initial: "loading",
    states: ["loading", "on", "off", "toggling", "unavailable", "closed"],
    observations: {
      loading: "starting-disabled",
      on: "translation-on-enabled",
      off: "translation-off-enabled",
      toggling: "toggling-disabled",
      unavailable: "page-unavailable-disabled",
      closed: "absent"
    },
    events: ["STATE_ON", "STATE_OFF", "CONTENT_BOOTING", "NO_RECEIVER", "CLICK", "SETTINGS_HINT", "CLOSE"],
    build(events) {
      const live = (state) => row(state, events, {
        STATE_ON: transition("on", "render-on"),
        STATE_OFF: transition("off", "render-off"),
        CONTENT_BOOTING: transition("loading", "render-starting"),
        NO_RECEIVER: transition("unavailable", "render-unavailable"),
        CLICK: transition("toggling", "ask-top-frame-to-toggle-live-state"),
        SETTINGS_HINT: transition(state, "render-shortcut-hint-only"),
        CLOSE: transition("closed", "clean")
      });
      return {
        loading: row("loading", events, {
          STATE_ON: transition("on", "render-on"),
          STATE_OFF: transition("off", "render-off"),
          CONTENT_BOOTING: transition("loading", "render-starting"),
          NO_RECEIVER: transition("unavailable", "render-unavailable"),
          SETTINGS_HINT: transition("loading", "render-shortcut-hint-only"),
          CLOSE: transition("closed", "clean")
        }),
        on: live("on"),
        off: live("off"),
        toggling: row("toggling", events, {
          STATE_ON: transition("on", "render-on"),
          STATE_OFF: transition("off", "render-off"),
          CONTENT_BOOTING: transition("loading", "render-starting"),
          NO_RECEIVER: transition("unavailable", "render-unavailable"),
          CLICK: transition("toggling", "ignore-duplicate-click"),
          SETTINGS_HINT: transition("toggling", "render-shortcut-hint-only"),
          CLOSE: transition("closed", "retire-and-clean")
        }),
        unavailable: row("unavailable", events, {
          STATE_ON: transition("on", "render-on"),
          STATE_OFF: transition("off", "render-off"),
          CONTENT_BOOTING: transition("loading", "render-starting"),
          NO_RECEIVER: transition("unavailable", "keep-unavailable"),
          SETTINGS_HINT: transition("unavailable", "render-shortcut-hint-only"),
          CLOSE: transition("closed", "clean")
        }),
        closed: closedRow(events)
      };
    }
  })
];

function defineMachine(definition) {
  const transitions = definition.build(definition.events);
  return { ...definition, transitions };
}

function validateMachine(machine) {
  const errors = [];
  const stateSet = new Set(machine.states);
  const eventSet = new Set(machine.events);

  if (!stateSet.has(machine.initial)) {
    errors.push(`initial state ${machine.initial} is undeclared`);
  }
  if (stateSet.size !== machine.states.length) {
    errors.push("states contain duplicates");
  }
  if (eventSet.size !== machine.events.length) {
    errors.push("events contain duplicates");
  }

  for (const state of machine.states) {
    const rowTransitions = machine.transitions[state];
    if (!rowTransitions) {
      errors.push(`state ${state} has no transition row`);
      continue;
    }
    const keys = Object.keys(rowTransitions);
    for (const event of machine.events) {
      const cell = rowTransitions[event];
      if (!cell) {
        errors.push(`missing transition (${state}, ${event})`);
        continue;
      }
      if (!stateSet.has(cell.to)) {
        errors.push(`transition (${state}, ${event}) targets undeclared state ${cell.to}`);
      }
      if (typeof cell.effect !== "string" || cell.effect.length === 0) {
        errors.push(`transition (${state}, ${event}) has no decidable effect label`);
      }
    }
    for (const event of keys) {
      if (!eventSet.has(event)) {
        errors.push(`state ${state} handles undeclared event ${event}`);
      }
    }
    if (keys.length !== eventSet.size) {
      errors.push(`state ${state} has ${keys.length} cells; expected ${eventSet.size}`);
    }
  }

  for (const state of Object.keys(machine.transitions)) {
    if (!stateSet.has(state)) {
      errors.push(`transition table contains undeclared state ${state}`);
    }
  }
  for (const state of machine.states) {
    if (typeof machine.observations[state] !== "string") {
      errors.push(`state ${state} has no user/system observation`);
    }
  }

  const reachable = new Set([machine.initial]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const state of [...reachable]) {
      for (const cell of Object.values(machine.transitions[state] ?? {})) {
        if (!reachable.has(cell.to)) {
          reachable.add(cell.to);
          changed = true;
        }
      }
    }
  }
  for (const state of machine.states) {
    if (!reachable.has(state)) {
      errors.push(`state ${state} is unreachable`);
    }
  }

  const equivalentGroups = findEquivalentStates(machine);
  for (const group of equivalentGroups) {
    errors.push(`behaviorally equivalent states must merge: ${group.join(", ")}`);
  }
  return errors;
}

function findEquivalentStates(machine) {
  let partition = groupBy(machine.states, (state) => machine.observations[state]);
  while (true) {
    const groupIndex = new Map();
    partition.forEach((group, index) => group.forEach((state) => groupIndex.set(state, index)));
    const refined = [];
    for (const group of partition) {
      refined.push(...groupBy(group, (state) => JSON.stringify([
        machine.observations[state],
        ...machine.events.map((event) => {
          const cell = machine.transitions[state][event];
          return [event, cell.effect, groupIndex.get(cell.to)];
        })
      ])));
    }
    if (refined.length === partition.length) {
      return refined.filter((group) => group.length > 1);
    }
    partition = refined;
  }
}

function groupBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const failures = [];
let transitionCount = 0;
let predicateCaseCount = 0;
for (const normalizer of normalizers) {
  for (const input of expandDomains(normalizer.domains)) {
    predicateCaseCount += 1;
    const matches = normalizer.rules.filter((rule) => rule.when(input));
    if (matches.length !== 1) {
      failures.push(`${normalizer.name}: ${JSON.stringify(input)} matched ${matches.length} rules`);
    }
  }
}
for (const machine of machines) {
  const errors = validateMachine(machine);
  transitionCount += machine.states.length * machine.events.length;
  failures.push(...errors.map((error) => `${machine.name}: ${error}`));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${normalizers.length} exclusive/exhaustive normalizers across ${predicateCaseCount} predicate cases, `
    + `plus ${machines.length} minimal total state machines and ${transitionCount} transition cells.`
  );
}

function expandDomains(domains) {
  let rows = [{}];
  for (const [name, values] of Object.entries(domains)) {
    rows = rows.flatMap((rowValue) => values.map((value) => ({ ...rowValue, [name]: value })));
  }
  return rows;
}
