import { Plugin } from "@elizaos/core";
import { XMTP_SERVICE_NAME } from "./constants";
import { XmtpService } from "./service";

// Export action and intent types and codecs
export { 
  ActionsCodec, 
  ContentTypeActions, 
  type ActionsContent, 
  type Action 
} from "./actions";
export { 
  IntentCodec, 
  ContentTypeIntent, 
  type IntentContent 
} from "./intent";

// Export helper functions
export {
  createActionsContent,
  createAction,
  createIntentContent,
  validateActionsContent,
  validateIntentContent,
} from "./helper";

const xmtpPlugin: Plugin = {
  name: XMTP_SERVICE_NAME,
  description: "XMTP service plugin for ElizaOS with support for actions and intents.",
  services: [XmtpService],
};
export default xmtpPlugin;
