import { IdentifierKind, Signer } from "@xmtp/node-sdk";
import { getRandomValues } from "node:crypto";
import { fromString, toString } from "uint8arrays";
import { Hex, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type SignerType = "EOA" | "SCW";

export const createEOASigner = (privateKey: Hex): Signer => {
  const account = privateKeyToAccount(privateKey);
  return {
    type: "EOA",
    signMessage: async (message: string) => {
      const signature = await account.signMessage({
        message,
      });
      return toBytes(signature);
    },
    getIdentifier: async () => {
      return {
        identifierKind: IdentifierKind.Ethereum,
        identifier: account.address.toLowerCase(),
      };
    },
  };
};

export const createSCWSigner = (privateKey: Hex, chainId: bigint): Signer => {
  const account = privateKeyToAccount(privateKey);
  return {
    type: "SCW",
    signMessage: async (message: string) => {
      const signature = await account.signMessage({
        message,
      });
      return toBytes(signature);
    },
    getIdentifier: async () => {
      return {
        identifierKind: IdentifierKind.Ethereum,
        identifier: account.address.toLowerCase(),
      };
    },
    getChainId() {
      return chainId;
    },
  };
};

export const generateEncryptionKeyHex = () => {
  const uint8Array = getRandomValues(new Uint8Array(32));
  return toString(uint8Array, "hex");
};

export const getEncryptionKeyFromHex = (hex: string) => {
  return fromString(hex, "hex");
};

// Action and Intent helper functions
import { ActionsContent, Action } from './actions';
import { IntentContent } from './intent';

export const createActionsContent = (
  id: string,
  description: string,
  actions: Action[],
  expiresAt?: string
): ActionsContent => {
  return {
    id,
    description,
    actions,
    ...(expiresAt && { expiresAt }),
  };
};

export const createAction = (
  id: string,
  label: string,
  style?: 'primary' | 'secondary' | 'danger',
  imageUrl?: string,
  expiresAt?: string
): Action => {
  return {
    id,
    label,
    ...(style && { style }),
    ...(imageUrl && { imageUrl }),
    ...(expiresAt && { expiresAt }),
  };
};

export const createIntentContent = (
  id: string,
  actionId: string,
  metadata?: Record<string, any>
): IntentContent => {
  return {
    id,
    actionId,
    ...(metadata && { metadata }),
  };
};

export const validateActionsContent = (content: any): content is ActionsContent => {
  return (
    typeof content === 'object' &&
    typeof content.id === 'string' &&
    typeof content.description === 'string' &&
    Array.isArray(content.actions) &&
    content.actions.every((action: any) => 
      typeof action.id === 'string' && 
      typeof action.label === 'string'
    )
  );
};

export const validateIntentContent = (content: any): content is IntentContent => {
  return (
    typeof content === 'object' &&
    typeof content.id === 'string' &&
    typeof content.actionId === 'string'
  );
};
