import type {
  ReceiverHealth as ContractReceiverHealth,
  ReceiverRealtimeState as ContractReceiverRealtimeState
} from "@flightmap/shared";

// These aliases keep collector internals easy to mock without widening the
// public contract.
export type ReceiverHealth = ContractReceiverHealth;
export type ReceiverRealtimeState = ContractReceiverRealtimeState;
