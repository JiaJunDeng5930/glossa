# Rust parser and comment binding

## Comment forms

Accept `//`, `///`, `//!`, `/* ... */`, and `/*! ... */` when the normalized comment content contains one tag, one ID, and one sentence. Prefer line comments and Rust doc comments because they bind naturally to items and statements.

The parser should extract the tag and ID from the start of the normalized comment content. The remaining content is the sentence. The validator should confirm that one sentence is present and that the sentence is local to the bound code unit.

## Item binding

Outer doc comments and immediately preceding line comments bind to the next Rust item when no executable code appears between the comment and the item. Rust item targets include `fn_item`, `struct_item`, `enum_item`, `trait_item`, `impl_item`, `type_item`, `const_item`, `static_item`, `mod_item`, `use_declaration`, and macro invocations that define routes, commands, schemas, or tests.

Inner module doc comments bind to the module or file. Use module-level comments for higher-level IDs such as `db.connection` or `pay.auth`, then use narrower descendant IDs for functions and inner blocks.

## Function-body binding

Inside a function, bind a requirement comment to the next meaningful node in the same block. Meaningful nodes include `if_expression`, `match_expression`, match arms, `for_expression`, `while_expression`, `loop_expression`, call expressions, method calls, assignment expressions, return expressions, try-like error propagation points, and macro invocations.

For `match`, allow a comment immediately before the whole match or immediately before a match arm. A state transition in one arm should use a narrower descendant ID on that arm.

For method chains, bind the comment to the chain expression when the chain expresses one local behavior. If separate calls in the chain encode separate requirements, require more specific descendant comments before those calls where the parser can bind them.

## Test binding

Bind `@verifies` to `#[test]`, `#[tokio::test]`, `#[rstest]`, similar test functions, assertion blocks, assertion macros, snapshot macros, mock setup calls, and fixture definitions. A test function can verify a broader behavior while assertion-level comments verify narrower descendant behavior.

## Binding failures

Fail comments that are floating, separated from the target by executable code, attached to the wrong sibling, or placed at the end of a block without a following target. The diagnostic should point to the comment and name the nearest candidate target when one exists.
