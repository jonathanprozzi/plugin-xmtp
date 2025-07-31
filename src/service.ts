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

    // Check for XMTP conversation type property
    if (conversation && typeof conversation.conversationType === 'number') {
      switch (conversation.conversationType) {
        case 0: // ConversationType.Dm
          return ChannelType.DM;
        case 1: // ConversationType.Group
          return ChannelType.GROUP;
        case 2: // ConversationType.Sync
          return ChannelType.DM; // Treat sync conversations as DM
        default:
          return ChannelType.DM;
      }
    }

    // Fallback: Check if this is a group based on available methods
    const conversationProto = conversation ? Object.getPrototypeOf(conversation) : null;
    const protoMethods = conversationProto ? Object.getOwnPropertyNames(conversationProto) : [];
    
    // If conversation has peerInboxId method, it's a DM (1-on-1 conversation)
    if (protoMethods.includes('peerInboxId')) {
      return ChannelType.DM;
    }
    
    // If conversation has group management methods, it's likely a group
    if (conversation && (
      typeof conversation.addMembers === 'function' ||
      typeof conversation.removeMembers === 'function' ||
      typeof conversation.addAdmin === 'function' ||
      typeof conversation.isAdmin === 'function' ||
      protoMethods.includes('addMembers') ||
      protoMethods.includes('removeMembers')
    )) {
      return ChannelType.GROUP;
    }
    
    // Check if members property exists and is callable
    if (conversation && typeof conversation.members === 'function') {
      return ChannelType.GROUP;
    }
    
    // Default to DM if we can't determine (safer for privacy)
    return ChannelType.DM;
  } catch (error) {
    logger.error('Error in getChannelType:', error);
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

  /**
   * Send a proactive message to an XMTP group by conversation ID
   * This allows sending messages without being in a conversation context
   */
  async sendProactiveMessage(conversationId: string, message: string): Promise<string> {
    try {
      logger.info(`🚀 Sending proactive message to conversation ${conversationId}`);
      
      // Get the conversation by ID
      const conversation = await this.client.conversations.getConversationById(conversationId);
      if (!conversation) {
        throw new Error(`Could not find XMTP conversation with ID: ${conversationId}`);
      }
      
      // Send the message
      const messageId = await conversation.send(message);
      logger.success(`✅ Proactive message sent to ${conversationId}: ${messageId}`);
      
      return messageId;
    } catch (error) {
      logger.error(`❌ Failed to send proactive message to ${conversationId}:`, error);
      throw error;
    }
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
        `Received message: ${message.content as string} from sender`
      );

      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
      );

      if (!conversation) {
        return;
      }

      await this.processMessage(message, conversation);

      logger.success("Waiting for messages...");
    });
  }

  private async processMessage(
    message: DecodedMessage<any>,
    conversation: Conversation
  ) {
    try {
      const text = message?.content ?? "";
      const entityId = createUniqueUuid(this.runtime, message.senderInboxId);
      const messageId = stringToUuid(message.id as string);
      const userId = stringToUuid(message.senderInboxId as string);
      const roomId = stringToUuid(message.conversationId as string);

      const channelType = getChannelType(conversation);

      // Resolve Ethereum address for userName to avoid inboxId contamination in conversation context
      let resolvedUserName = message.senderInboxId; // fallback
      try {
        logger.info('🔍 Attempting to resolve address for inboxId:', message.senderInboxId);
        const inboxStates = await this.client.preferences.inboxStateFromInboxIds([message.senderInboxId], false);
        logger.info('📋 InboxStates received:', inboxStates.length);
        
        if (inboxStates.length > 0) {
          const ethAddresses = inboxStates[0].identifiers
            .filter((id) => id.identifierKind === 0) // Ethereum only
            .map((id) => id.identifier);
          
          logger.info('🔍 Found Ethereum addresses:', ethAddresses);
          
          if (ethAddresses.length > 0) {
            resolvedUserName = ethAddresses[0]; // Use resolved Ethereum address
            logger.info('✅ Resolved userName:', resolvedUserName);
          } else {
            logger.warn('⚠️ No Ethereum addresses found for inboxId');
          }
        } else {
          logger.warn('⚠️ No inbox states returned for inboxId');
        }
      } catch (error) {
        logger.error('❌ Address resolution failed:', error);
        // Continue with inboxId fallback
      }

      logger.info('🆔 Entity IDs generated:', {
        senderInboxId: message.senderInboxId,
        startsWithNumber: /^[0-9]/.test(message.senderInboxId),
        entityId,
        userId,
        resolvedUserName
      });

      await this.runtime.ensureConnection({
        entityId,
        userName: resolvedUserName,
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
        channelType: channelType,
        inReplyTo: undefined,
        metadata: {
          senderInboxId: message.senderInboxId,
          senderAddress: resolvedUserName, // Include resolved address for MCP context
          // This ensures MCP tool selection can see the proper Ethereum address
        },
      };

      logger.info('📦 Message metadata with resolved address:', {
        senderInboxId: message.senderInboxId,
        senderAddress: resolvedUserName,
        source: 'xmtp'
      });

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
