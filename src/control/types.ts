export type { BindingDefinition } from "./binding.js";
export type { Trigger, TriggerConfig } from "./trigger.js";
export type TriggerDefinition = Pick<import("./trigger.js").Trigger, "type" | "config">;
