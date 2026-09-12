// Run all suites in one Node test worker so TypeScript source-map coverage is
// merged accurately across the production modules shared by these tests.
import "./parser.test.mjs";
import "./resolver.test.mjs";
import "./e2e.test.mjs";
