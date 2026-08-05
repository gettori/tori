import { describe, it, expect } from "vitest";
import { configurationFor, configurationClientCapabilities } from "./lspConfiguration";

// What `yaml-language-server` actually asks for, in the order it asks
// (`settingsHandlers.js:45-51`). Sway has an opinion about exactly one of them,
// which is the case the positional rule below exists for.
const YAML_ITEMS = [
  { section: "yaml" },
  { section: "http" },
  { section: "[yaml]" },
  { section: "editor" },
  { section: "files" },
];

const YAML_SETTINGS = {
  yaml: {
    validate: true,
    completion: true,
    hover: true,
    schemaStore: { enable: true, url: "https://www.schemastore.org/api/json/catalog.json" },
  },
};

describe("configurationFor", () => {
  it("answers one value per requested section, in order", () => {
    // Positional, which the protocol requires: the server reads the reply by
    // index, so dropping the sections Sway has nothing to say about would
    // shift `[yaml]`'s answer onto `http` and hand the server its own
    // configuration under the wrong name.
    const answer = configurationFor(YAML_SETTINGS, { items: YAML_ITEMS });

    expect(answer).toHaveLength(YAML_ITEMS.length);
    expect(answer[0]).toEqual(YAML_SETTINGS.yaml);
    expect(answer.slice(1)).toEqual([null, null, null, null]);
  });

  it("carries the schema-store settings through unchanged", () => {
    // Every key here is read by name on the other side, so a reshaping in
    // transit is a setting that silently keeps its default.
    const [yaml] = configurationFor(YAML_SETTINGS, { items: [{ section: "yaml" }] }) as [
      { schemaStore: { enable: boolean; url: string } },
    ];

    expect(yaml.schemaStore).toEqual({
      enable: true,
      url: "https://www.schemastore.org/api/json/catalog.json",
    });
  });

  it("follows a dotted section name into the table", () => {
    // LSP section names are paths. A server may ask for `yaml` or for
    // `yaml.schemaStore`, and both have to find the same values.
    const answer = configurationFor(YAML_SETTINGS, {
      items: [{ section: "yaml.schemaStore" }, { section: "yaml.schemaStore.enable" }],
    });

    expect(answer[0]).toEqual(YAML_SETTINGS.yaml.schemaStore);
    expect(answer[1]).toBe(true);
  });

  it("answers null for a section this config says nothing about", () => {
    // Not omitted, and not an error. `http`, `editor` and `files` are asked for
    // by a server that will do something sensible with "no opinion".
    expect(configurationFor(YAML_SETTINGS, { items: [{ section: "nothing" }] })).toEqual([null]);
    expect(configurationFor(YAML_SETTINGS, { items: [{ section: "yaml.absent.deeper" }] })).toEqual([null]);
    expect(configurationFor(YAML_SETTINGS, { items: [{ section: "yaml.validate.deeper" }] })).toEqual([null]);
  });

  it("answers the whole configuration when no section is named", () => {
    expect(configurationFor(YAML_SETTINGS, { items: [{}] })).toEqual([YAML_SETTINGS]);
  });

  it("answers null for every section when the server has no settings at all", () => {
    // A server whose TOML carries no `[settings]`, which is most of them. It
    // still gets an answer of the right length rather than a `-32601`.
    expect(configurationFor(null, { items: YAML_ITEMS })).toEqual([null, null, null, null, null]);
    expect(configurationFor(null, { items: [{}] })).toEqual([null]);
  });

  it("answers nothing at all for a request that names no items", () => {
    for (const params of [null, undefined, {}, { items: "not a list" }, "junk"]) {
      expect(configurationFor(YAML_SETTINGS, params), JSON.stringify(params)).toEqual([]);
    }
  });

  it("ignores scopeUri rather than failing on it", () => {
    // Sway's settings are per server, not per folder. Answering the same value
    // for every scope is exactly right until they are not.
    const answer = configurationFor(YAML_SETTINGS, {
      items: [{ section: "yaml", scopeUri: "file:///proj/a" }],
    });
    expect(answer).toEqual([YAML_SETTINGS.yaml]);
  });
});

describe("configurationClientCapabilities", () => {
  it("declares the capability the answering keeps a promise about", () => {
    // A client that declares `configuration` and then answers -32601 tells a
    // conformant server it lied, and the reasonable response to that is to
    // stop asking. Declaring it is the half that makes the router's answer
    // something the server will trust.
    expect(configurationClientCapabilities.clientCapabilities.workspace.configuration).toBe(true);
    expect(
      configurationClientCapabilities.clientCapabilities.workspace.didChangeConfiguration,
    ).toEqual({ dynamicRegistration: false });
  });
});
