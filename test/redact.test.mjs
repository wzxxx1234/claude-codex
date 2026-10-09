import test from "node:test";
import assert from "node:assert/strict";

import { redactSecrets } from "../src/redact.mjs";

test("redactSecrets hides bearer tokens, API keys, and token fields", () => {
  const input = [
    "Authorization: Bearer secret-token",
    "api_key=sk-test-123456",
    '"token":"abc123"'
  ].join("\n");

  const output = redactSecrets(input);

  assert.doesNotMatch(output, /secret-token|sk-test-123456|abc123/);
  assert.match(output, /\[REDACTED\]/);
});

test("redactSecrets handles nested objects without mutating the input", () => {
  const input = {
    safe: "visible",
    nested: {
      api_key: "secret-value",
      note: "Authorization: Bearer another-secret"
    }
  };

  const output = redactSecrets(input);

  assert.equal(input.nested.api_key, "secret-value");
  assert.match(output, /visible/);
  assert.doesNotMatch(output, /secret-value|another-secret/);
  assert.match(output, /\[REDACTED\]/);
});
