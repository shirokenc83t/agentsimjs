/** The `user_data` namespace where a provider key the user chose to remember on this device lives (ADR-0044 §3). Its own module: the main thread reads the name without taking the storage worker's code with it. */
export const PROVIDER_KEYS_NAMESPACE = "providerKeys";
