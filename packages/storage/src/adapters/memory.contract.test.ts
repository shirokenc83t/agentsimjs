import { describeStorageContract } from "../testing/contract.ts";
import { createMemoryPorts } from "./memory.ts";

describeStorageContract("in-memory", async () => ({ ports: createMemoryPorts(), dispose: async () => {} }));
