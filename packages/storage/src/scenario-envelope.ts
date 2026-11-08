import { contentHash, err, isValid, ok, type Result } from "@agentsim/core";
import Type from "typebox";
import type { ScenarioSaveError } from "./ports.ts";

/** Same bound as ADR-0025 (64 MiB), on the stored JSON text. */
export const MAX_SCENARIO_DOCUMENT_CHARS = 64 * 1024 * 1024;

/**
 * Envelope every stored scenario must have. Storage does not depend on the scenario schema (layering);
 * full validation happens in `@agentsim/scenarios` on import and on every load.
 */
const Envelope = Type.Object({
  schemaVersion: Type.Integer({ minimum: 0 }),
  id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
});

/** Checks the envelope and serializes the document once (the stored text) with its content hash. */
export function checkScenarioEnvelope(document: unknown): Result<{ id: string; name: string; json: string; contentHash: string }, ScenarioSaveError> {
  if (typeof document !== "object" || document === null || Array.isArray(document) || !isValid(Envelope, document)) {
    return err({ code: "invalid_document", message: "scenario document needs schemaVersion, id and name" });
  }
  const json = JSON.stringify(document);
  if (json.length > MAX_SCENARIO_DOCUMENT_CHARS) return err({ code: "too_large", message: "scenario document exceeds 64 MiB" });
  return ok({ id: document.id, name: document.name, json, contentHash: contentHash(json) });
}

/** ADR-0028 run configuration size limit (1 MiB), on the stored JSON text. */
export const MAX_RUN_CONFIG_DOCUMENT_CHARS = 1024 * 1024;

const PresetEnvelope = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  document: Type.Object({ schemaVersion: Type.Integer({ minimum: 0 }) }),
});

/** Envelope of a run configuration preset; the document itself is validated by `@agentsim/scenarios`. */
export function checkRunConfigPreset(preset: unknown): Result<{ id: string; name: string; json: string; contentHash: string }, ScenarioSaveError> {
  if (!isValid(PresetEnvelope, preset) || Array.isArray(preset.document)) {
    return err({ code: "invalid_document", message: "a preset needs an id, a name and a document with schemaVersion" });
  }
  const json = JSON.stringify(preset.document);
  if (json.length > MAX_RUN_CONFIG_DOCUMENT_CHARS) return err({ code: "too_large", message: "run configuration exceeds 1 MiB" });
  return ok({ id: preset.id, name: preset.name, json, contentHash: contentHash(json) });
}

/** The most a library document (a mind profile or a prompt template) may hold. */
const MAX_LIBRARY_DOCUMENT_CHARS = 256 * 1024;

/** Envelope of a library document (ADR-0036): an id, a name and a document with its schemaVersion; the document itself is validated by `@agentsim/minds`. */
export function checkLibraryDocument(doc: unknown): Result<{ id: string; name: string; json: string; contentHash: string }, ScenarioSaveError> {
  if (!isValid(PresetEnvelope, doc) || Array.isArray(doc.document)) return err({ code: "invalid_document", message: "a library document needs an id, a name and a document with schemaVersion" });
  const json = JSON.stringify(doc.document);
  if (json.length > MAX_LIBRARY_DOCUMENT_CHARS) return err({ code: "too_large", message: "a library document is limited to 256 KiB" });
  return ok({ id: doc.id, name: doc.name, json, contentHash: contentHash(json) });
}

/** xxHash32 of the UTF-8 text as 8 hex digits (identifies a stored version's exact content); one definition in core. */
export { contentHash };
