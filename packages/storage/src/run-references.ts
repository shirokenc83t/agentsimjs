import { err, ok, type CodedError, type Result } from "@agentsim/core";
import type { RunHeader } from "@agentsim/trace";

/** Header consistency the schema cannot express: a scenario reference names both id and version. */
export function checkRunReferences(h: RunHeader): Result<void, CodedError<"invalid_header">> {
  if ((h.scenarioId === undefined) !== (h.scenarioVersion === undefined)) {
    return err({ code: "invalid_header", message: "scenarioId and scenarioVersion go together" });
  }
  return ok(undefined);
}
