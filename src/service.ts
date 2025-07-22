import {
  ChannelType,
  Content,
  createUniqueUuid,
  elizaLogger,
  EventType,
  HandlerCallback,
  IAgentRuntime,
  logger,
  Memory,
  Service,
  stringToUuid,
} from "@elizaos/core";
import {
  Conversation,
  DecodedMessage,
  Client as XmtpClient,
} from "@xmtp/node-sdk";
import { XMTP_SERVICE_NAME } from "./constants";
import { createSCWSigner, createEOASigner } from "./helper";

/**
 * Determine the correct channel type based on XMTP conversation
 * Maps XMTP ConversationType to ElizaOS ChannelType
 */
function getChannelType(conversation: any): ChannelType {
  try {
    console.log('🔍 [DEBUG] getChannelType() CALLED - This should detect GROUP!');
    logger.info('🔍 [DEBUG] getChannelType() - Raw conversation object:', {
      conversationType: conversation?.conversationType,
      conversationTypeType: typeof conversation?.conversationType,
      membersType: typeof conversation?.members,
      hasMembers: !!conversation?.members,
      conversationKeys: conversation ? Object.keys(conversation) : 'null',
      hasMembersMethod: typeof conversation?.members === 'function',
      hasAddMembers: typeof conversation?.addMembers === 'function',
      hasRemoveMembers: typeof conversation?.removeMembers === 'function',
    });

    // Check for XMTP conversation type property
    if (conversation && typeof conversation.conversationType === 'number') {
      logger.info(`🎯 [DEBUG] Found numeric conversationType: ${conversation.conversationType}`);
      switch (conversation.conversationType) {
        case 0: // ConversationType.Dm
          logger.info('✅ [DEBUG] Detected DM conversation (type 0)');
          return ChannelType.DM;
        case 1: // ConversationType.Group
          logger.info('✅ [DEBUG] Detected GROUP conversation (type 1)');
          return ChannelType.GROUP;
        case 2: // ConversationType.Sync
          logger.info('✅ [DEBUG] Detected SYNC conversation (type 2), treating as DM');
          return ChannelType.DM; // Treat sync conversations as DM
        default:
          logger.warn(`❌ [DEBUG] Unknown XMTP conversation type: ${conversation.conversationType}`);
          return ChannelType.DM;
      }
    }

    // Fallback: Check if this is a group based on available methods
    logger.info('🔄 [DEBUG] No conversationType found, trying method-based detection');
    
    // If conversation has group management methods, it's likely a group
    if (conversation && (
      typeof conversation.addMembers === 'function' ||
      typeof conversation.removeMembers === 'function' ||
      typeof conversation.addAdmin === 'function' ||
      typeof conversation.isAdmin === 'function'
    )) {
      logger.info('✅ [DEBUG] Detected GROUP by available methods (addMembers, removeMembers, etc.)');
      return ChannelType.GROUP;
    }

    // Note: Can't call async members() method in sync function
    // But we already detected GROUP by methods above, so this fallback isn't needed
    logger.info('🔍 [DEBUG] Skipping members() method call (would require async)');

    // Default to DM if we can't determine
    logger.info('⚠️ [DEBUG] Defaulting to DM - no reliable detection method found');
    return ChannelType.DM;
  } catch (error) {
    logger.error('💥 [DEBUG] Error in getChannelType:', error);
    return ChannelType.DM; // Safe default
  }
}

export class XmtpService extends Service {
  static serviceType = XMTP_SERVICE_NAME;

  capabilityDescription =
    "The agent is able to send and receive messages using XMTP.";

  private client: XmtpClient;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.log("Constructing new XmtpService...");

    const service = new XmtpService(runtime);

    await service.setupClient()

    await service.setupMessageHandler();

    return service;
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {}

  stop(): Promise<void> {
   return Promise.resolve();
  }

  private async setupClient() {
    const walletKey = this.runtime.getSetting("WALLET_KEY");
    const signerType = this.runtime.getSetting("XMTP_SIGNER_TYPE");
    const chainId = this.runtime.getSetting("XMTP_SCW_CHAIN_ID");
    const env = this.runtime.getSetting("XMTP_ENV") || "production";

    const signer =
      signerType === "SCW"
        ? createSCWSigner(walletKey, BigInt(chainId))
        : createEOASigner(walletKey);

    const client = await XmtpClient.create(signer, { env });

    this.client = client;

    logger.success("XMTP client created successfully with inboxId: ", this.client.inboxId);
  }

  private async setupMessageHandler() {
    this.client.conversations.streamAllMessages(async (err, message) => {
      if (err) {
        logger.error("Error streaming messages", err);
        return;
      }

      if (
        message?.senderInboxId.toLowerCase() ===
          this.client.inboxId.toLowerCase() ||
        message?.contentType?.typeId !== "text"
      ) {
        return;
      }

      // Ignore own messages
      if (message.senderInboxId === this.client.inboxId) {
        return;
      }

      logger.success(
        `Received message: ${message.content as string} by ${
          message.senderInboxId
        }`
      );

      logger.info('🔍 [DEBUG] Fetching conversation by ID:', message.conversationId);
      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );

      if (!conversation) {
        logger.error("❌ [DEBUG] Unable to find conversation, skipping");
        return;
      }

      logger.info('✅ [DEBUG] Conversation found, inspecting properties:', {
        conversationId: conversation.id || 'unknown',
        conversationType: conversation.conversationType,
        hasMembers: !!conversation.members,
        memberCount: conversation.members?.length || 'unknown',
        conversationMethods: typeof conversation === 'object' ? Object.getOwnPropertyNames(Object.getPrototypeOf(conversation)) : 'not an object',
      });

      logger.success(`Sending "gm" response...`);

      await this.processMessage(message, conversation);

      logger.success("Waiting for messages...");
    });
  }

  private async processMessage(
    message: DecodedMessage<any>,
    conversation: Conversation
  ) {
    try {
      logger.info('🚨 [DEBUG] processMessage ENTRY POINT - This should be a GROUP!', {
        conversationId: message.conversationId,
        senderInboxId: message.senderInboxId,
        conversationObjectType: typeof conversation,
        conversationExists: !!conversation,
      });
      const text = message?.content ?? "";
      const entityId = createUniqueUuid(this.runtime, message.senderInboxId);
      const messageId = stringToUuid(message.id as string);
      const userId = stringToUuid(message.senderInboxId as string);
      const roomId = stringToUuid(message.conversationId as string);

      logger.info('🚀 [DEBUG] Starting processMessage with conversation object');
      
      // Deep inspection of conversation object
      logger.info('🔬 [DEBUG] Conversation object deep inspection:', {
        conversationId: conversation.id,
        conversationType: conversation.conversationType,
        conversationTypeType: typeof conversation.conversationType,
        isConversationTypeNumber: typeof conversation.conversationType === 'number',
        allProperties: conversation ? Object.keys(conversation) : 'null conversation',
        membersExists: 'members' in conversation,
        membersType: typeof conversation.members,
        membersLength: conversation.members?.length,
        membersArray: conversation.members,
      });

      const channelType = getChannelType(conversation);
      
      logger.info(`📋 [DEBUG] Final processing results:`, {
        conversationId: message.conversationId,
        originalConversationType: conversation.conversationType,
        memberCount: conversation.members?.length,
        detectedChannelType: channelType === ChannelType.DM ? 'DM' : 'GROUP',
        channelTypeEnum: channelType,
        senderInboxId: message.senderInboxId,
      });

      logger.info('🔗 [DEBUG] Calling ensureConnection with:', {
        entityId,
        userName: message.senderInboxId,
        userId,
        roomId,
        channelId: message.conversationId,
        serverId: message.conversationId,
        source: "xmtp",
        type: channelType,
        typeString: channelType === ChannelType.DM ? 'DM' : 'GROUP',
        typeValue: channelType,
        ChannelTypeDM: ChannelType.DM,
        ChannelTypeGROUP: ChannelType.GROUP,
        typeComparison: {
          isDM: channelType === ChannelType.DM,
          isGROUP: channelType === ChannelType.GROUP,
        },
        worldId: roomId,
      });

      await this.runtime.ensureConnection({
        entityId,
        userName: message.senderInboxId,
        userId,
        roomId,
        channelId: message.conversationId,
        serverId: message.conversationId,
        source: "xmtp",
        type: channelType,
        worldId: roomId,
      });

      const content: Content = {
        text,
        source: "xmtp",
        inReplyTo: undefined,
        metadata: {
          senderInboxId: message.senderInboxId,
          senderAddress: message.senderInboxId,
        },
      };

      const memory: Memory = {
        id: messageId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content
      };

      const callback: HandlerCallback = async (
        content: Content,
        _files?: string[]
      ) => {
        try {
          if (!content.text) return [];

          const responseMessageId = await conversation.send(content.text);

          logger.info('💾 [DEBUG] Creating response memory with channelType:', {
            responseMessageId,
            channelType,
            channelTypeString: channelType === ChannelType.DM ? 'DM' : 'GROUP',
            inReplyTo: messageId,
          });

          const responseMemory: Memory = {
            id: createUniqueUuid(this.runtime, responseMessageId),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId,
            content: {
              ...content,
              text: content.text,
              inReplyTo: messageId,
              channelType: channelType,
              metadata: {
                ...content.metadata,
                originalSenderInboxId: message.senderInboxId,
                replyingToSender: message.senderInboxId,
              },
            }
          };

          await this.runtime.createMemory(responseMemory, "messages");

          return [responseMemory];
        } catch (error) {
          elizaLogger.error("Error in callback", error);
        }
      };

      this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: "xmtp",
      });
    } catch (error) {
      elizaLogger.error("Error in onMessage", error);
    }
  }
}
