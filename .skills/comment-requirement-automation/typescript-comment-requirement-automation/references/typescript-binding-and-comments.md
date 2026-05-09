# TypeScript binding and comments

## Accepted comments

Accept `//`, `/* ... */`, and `/** ... */` comments. Normalize leading `*` characters in block comments, then parse exactly one tag, one dotted ID, and one sentence.

Reject comment blocks that contain multiple requirement tags. Require separate comment blocks for separate IDs so each tag can bind to one code unit.

## Declaration binding

Bind a leading requirement comment to the next declaration or assignment when no executable statement appears between them. Declaration targets include `function`, `class`, `interface`, `type`, `enum`, `const`, `let`, `var`, exported declarations, default exports, class methods, class properties, object methods, and arrow functions assigned to variables.

For React, bind comments to function components, component constants, exported props types, hooks, and provider components. For framework code, bind comments to route functions, controller methods, resolver functions, tRPC procedures, Next.js route handlers, Express/Fastify route registrations, and NestJS decorated handlers.

## Statement binding

Inside functions, bind a comment to the next statement or expression that owns the requirement. Valid targets include `if`, `else`, `switch`, `case`, loops, `try`, `catch`, `finally`, awaited calls, function calls, assignments, returns, throws, `new` expressions, schema definitions, event publication, database writes, and logging or metric calls when those calls are expected behavior.

For promise chains, bind to the chain expression when the chain expresses one local behavior. If `.catch`, `.finally`, retry wrapper, timeout wrapper, or error mapping encodes its own requirement, require a narrower descendant ID at that call or callback.

## Test binding

Bind `@verifies` to Jest, Vitest, node:test, Mocha, Playwright, Cypress, React Testing Library, Testing Library user-event scenarios, assertion calls, snapshot assertions, mock setup, fixture definitions, and MSW or nock handlers.

A test function can verify a broader behavior while assertion-level comments verify narrower descendant behavior. `@verifies` must reference an existing `@behavior` or `@constraint` ID.

## Invalid binding

A tag is invalid when it floats above unrelated executable code, appears at the end of a block without a following target, or binds only to a blank region. File-level tags are valid only before imports or the first executable statement.
