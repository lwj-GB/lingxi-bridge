import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(
  webRoot,
  "../../packages/schemas/live-session.schema.json",
);
const outputPath = resolve(
  webRoot,
  "src/live-session.validator.generated.js",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({
  strict: false,
  code: { source: true, esm: true },
  formats: {
    uuid:
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  },
});

const generated = standaloneCode(ajv, ajv.compile(schema))
  .replace(
    '"use strict";',
    '"use strict";\nimport ucs2length from "ajv/dist/runtime/ucs2length.js";',
  )
  .replace(
    /const (func\d+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/,
    "const $1 = ucs2length;",
  );

if (generated.includes("require(")) {
  throw new Error("Generated live-session validator still contains CommonJS imports.");
}

writeFileSync(
  outputPath,
  `// Generated from packages/schemas/live-session.schema.json. Do not edit.\n${generated}\n`,
);
