// dynamic-qa/shared/scripts/restricted-yaml.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRestrictedYAML, YamlSyntaxError } from "./restricted-yaml.mjs";

test("parses nested mappings, sequences, and scalar types", () => {
  const value = parseRestrictedYAML(`
schema: dynamic-qa-flow-v1
revision: 3
enabled: true
disabled: false
missing: null
tilde_missing: ~
ratio: 1.5
tickets:
  - "https://example.com/1"
  - 'https://example.com/2'
nested:
  a: 1
  b:
    c: 2
list_of_maps:
  - id: x
    name: "X"
  - id: y
    name: "Y"
`);
  assert.equal(value.schema, "dynamic-qa-flow-v1");
  assert.equal(value.revision, 3);
  assert.equal(value.enabled, true);
  assert.equal(value.disabled, false);
  assert.equal(value.missing, null);
  assert.equal(value.tilde_missing, null);
  assert.equal(value.ratio, 1.5);
  assert.deepEqual(value.tickets, ["https://example.com/1", "https://example.com/2"]);
  assert.deepEqual(value.nested, { a: 1, b: { c: 2 } });
  assert.deepEqual(value.list_of_maps, [
    { id: "x", name: "X" },
    { id: "y", name: "Y" },
  ]);
});

test("strips comments outside quotes but preserves '#' inside quoted strings", () => {
  const value = parseRestrictedYAML(`
title: "a # not a comment"
after: fine # this is a comment
`);
  assert.equal(value.title, "a # not a comment");
  assert.equal(value.after, "fine");
});

test("rejects YAML aliases", () => {
  assert.throws(() => parseRestrictedYAML("intent: *anchor\n"), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /aliases.*not supported/i);
    return true;
  });
});

test("rejects YAML anchors", () => {
  assert.throws(() => parseRestrictedYAML("title: &t \"hi\"\n"), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /anchors.*not supported/i);
    return true;
  });
});

test("rejects custom/explicit YAML tags", () => {
  assert.throws(() => parseRestrictedYAML('intent: !!python/object:os.system "rm -rf /"\n'), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /tags.*not supported/i);
    return true;
  });
});

test("rejects duplicate keys within one mapping", () => {
  assert.throws(
    () =>
      parseRestrictedYAML(`
title: "first"
title: "second"
`),
    (err) => {
      assert.ok(err instanceof YamlSyntaxError);
      assert.match(err.message, /duplicate key/i);
      return true;
    },
  );
});

test("rejects tab-indented lines", () => {
  assert.throws(() => parseRestrictedYAML("a:\n\tb: 1\n"), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /tab/i);
    return true;
  });
});

test("rejects non-empty flow-style collections", () => {
  assert.throws(() => parseRestrictedYAML("list: [1, 2, 3]\n"), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /flow-style/i);
    return true;
  });
  assert.throws(() => parseRestrictedYAML("obj: {a: 1}\n"), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /flow-style/i);
    return true;
  });
});

test("allows the empty-collection literals '[]' and '{}' as a narrow exception", () => {
  const value = parseRestrictedYAML("list: []\nobj: {}\n");
  assert.deepEqual(value.list, []);
  assert.deepEqual(value.obj, {});
});

test("rejects block scalar indicators", () => {
  assert.throws(() => parseRestrictedYAML("text: |\n  line one\n"), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /block scalars/i);
    return true;
  });
});

test("rejects document markers", () => {
  assert.throws(() => parseRestrictedYAML("---\ntitle: x\n"), (err) => {
    assert.ok(err instanceof YamlSyntaxError);
    assert.match(err.message, /document markers/i);
    return true;
  });
});

test("error messages name the offending line", () => {
  try {
    parseRestrictedYAML("a: 1\nb: *alias\n");
    assert.fail("expected a throw");
  } catch (err) {
    assert.equal(err.line, 2);
  }
});

test("a mapping key literally named '__proto__' parses as ordinary data, without polluting the prototype", () => {
  const value = parseRestrictedYAML(`
__proto__:
  polluted: true
a: 1
`);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(value, "__proto__"), true);
  assert.deepEqual(Object.keys(value).sort(), ["__proto__", "a"]);
  const protoDescriptor = Object.getOwnPropertyDescriptor(value, "__proto__");
  assert.equal(protoDescriptor.value.polluted, true);

  // Global Object.prototype must be untouched.
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});
