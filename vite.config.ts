import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: ["src/index.ts", "src/testing.ts"],
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      // Size and shape limits. Every threshold below is set just above what
      // this repository already contains, so it binds the next file rather
      // than demanding a refactor of the current one -- and each exception is
      // named with its measured value instead of switched off, so growing past
      // today's size is a decision someone makes on purpose.
      //
      // Blank lines and comments are excluded from the count. This codebase
      // comments heavily, and a limit that counted prose would be a limit on
      // explaining yourself.
      "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }],
      "max-depth": ["error", { max: 4 }],
      complexity: ["error", { max: 25 }],
      // Files are kebab-case: `file-media.ts`, `store-conformance.ts`.
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
    },
    overrides: [
      {
        // The dependency direction, enforced rather than described. `model/`
        // is pure domain types, `runtime/` builds on the model, and
        // `baileys/` is the only layer that knows the wire protocol. The code
        // already obeys this -- the rule keeps it that way, since the drift is
        // invisible until something in `model/` suddenly needs a socket to be
        // tested.
        //
        // Scoped to `model/` rather than global: the restriction is about what
        // the *bottom* layer may reach for. Applied everywhere it flagged 34
        // legitimate imports, because `runtime/` importing `runtime/` is the
        // normal case.
        //
        // Note also the absence of `importNames: ["*"]`. It reads like "any
        // import" and means "a named export literally called `*`", so the rule
        // matches nothing while the config still looks correct -- this was
        // written that way first, and a probe importing `runtime/` from
        // `model/` passed clean.
        files: ["src/model/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["**/runtime/*", "**/baileys/*"],
                  message:
                    "src/model/ is pure domain types: it must not import from runtime/ or baileys/. Depend on the model from those layers instead.",
                },
              ],
            },
          ],
        },
      },
      {
        // The protocol boundary. `toInbound` and `context` map WhatsApp's
        // message shapes onto the domain, and `transition` is the connection
        // state machine -- all three are exhaustive switches over a closed
        // protocol union, where the branch count *is* the specification.
        // Splitting them hides which cases are handled, and the defect ledger
        // records what happens when this layer is restructured for tidiness.
        files: ["src/baileys/inbound.ts", "src/baileys/outbound.ts", "src/machine.ts"],
        rules: { complexity: ["error", { max: 45 }] },
      },
      {
        // Durable projection: the same exhaustiveness against stored shapes.
        files: ["src/runtime/projection.ts", "src/runtime/libsql.ts", "src/session.ts"],
        rules: { complexity: ["error", { max: 35 }] },
      },
      {
        // 1454 code lines, and the only file over the limit. It is the libSQL
        // schema plus every statement written against it, so the schema and
        // its queries stay legible side by side. Splitting it is a real option
        // and not a free one; until then the number is written down.
        files: ["src/runtime/libsql.ts"],
        rules: { "max-lines": ["error", { max: 1500, skipBlankLines: true, skipComments: true }] },
      },
      {
        // Lease acquisition and teardown, where the nesting is a sequence of
        // guarded recoveries that each have to unwind what the one before did.
        files: ["src/runtime/runtime.ts"],
        rules: { "max-depth": ["error", { max: 6 }] },
      },
      {
        // Test files state a scenario per case and grow with the surface they
        // cover; a line limit there would push tests into being fewer and
        // vaguer. The `_expect.ts` helper keeps its leading underscore, which
        // is how it stays outside the `*.test.ts` glob.
        files: ["tests/**"],
        rules: {
          "max-lines": "off",
          complexity: "off",
          "max-depth": "off",
          "unicorn/filename-case": "off",
        },
      },
    ],
  },
  fmt: {},
});
