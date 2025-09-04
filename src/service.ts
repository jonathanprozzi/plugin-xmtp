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
} from '@elizaos/core';
import {
  Conversation,
  DecodedMessage,
  Client as XmtpClient,
} from '@xmtp/node-sdk';
import {
  ContentTypeReaction,
  ReactionCodec,
} from '@xmtp/content-type-reaction';
import {
  ContentTypeReply,
  ReplyCodec,
} from '@xmtp/content-type-reply';
import { ContentTypeText } from '@xmtp/content-type-text';
import { ActionsCodec, ContentTypeActions } from './actions';
import { IntentCodec, ContentTypeIntent } from './intent';
import { XMTP_SERVICE_NAME } from './constants';
import {
  createSCWSigner,
  createEOASigner,
  getEncryptionKeyFromHex,
} from './helper';
import fs from 'fs';

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
    const conversationProto = conversation
      ? Object.getPrototypeOf(conversation)
      : null;
    const protoMethods = conversationProto
      ? Object.getOwnPropertyNames(conversationProto)
      : [];

    // If conversation has peerInboxId method, it's a DM (1-on-1 conversation)
    if (protoMethods.includes('peerInboxId')) {
      return ChannelType.DM;
    }

    // If conversation has group management methods, it's likely a group
    if (
      conversation &&
      (typeof conversation.addMembers === 'function' ||
        typeof conversation.removeMembers === 'function' ||
        typeof conversation.addAdmin === 'function' ||
        typeof conversation.isAdmin === 'function' ||
        protoMethods.includes('addMembers') ||
        protoMethods.includes('removeMembers'))
    ) {
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
    'The agent is able to send and receive messages using XMTP.';

  private client: XmtpClient;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.log('🚀 Starting XmtpService with reply and reaction support...');

    const service = new XmtpService(runtime);

    await service.setupClient();

    await service.setupMessageHandler();
    
    logger.success('✅ XmtpService started successfully with reply threading and reaction support enabled');

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
  async sendProactiveMessage(
    conversationId: string,
    message: string
  ): Promise<string> {
    try {
      logger.info(
        `🚀 Sending proactive message to conversation ${conversationId}`
      );

      // Get the conversation by ID
      const conversation =
        await this.client.conversations.getConversationById(conversationId);
      if (!conversation) {
        throw new Error(
          `Could not find XMTP conversation with ID: ${conversationId}`
        );
      }

      // Send the message
      const messageId = await conversation.send(message);
      logger.success(
        `✅ Proactive message sent to ${conversationId}: ${messageId}`
      );

      return messageId;
    } catch (error) {
      logger.error(
        `❌ Failed to send proactive message to ${conversationId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Send an actions message to an XMTP conversation
   * This allows sending interactive buttons for user selection
   */
  async sendActions(
    conversationId: string,
    actionsContent: any
  ): Promise<string> {
    try {
      logger.info(
        `🎯 sendActions called with conversationId: ${conversationId}`
      );
      logger.info('🎯 ActionsContent:', {
        id: actionsContent?.id,
        description: actionsContent?.description,
        actions: actionsContent?.actions?.length
      });

      // Get the conversation by ID
      const conversation =
        await this.client.conversations.getConversationById(conversationId);
      if (!conversation) {
        throw new Error(
          `Could not find XMTP conversation with ID: ${conversationId}`
        );
      }

      // Send the actions message
      const messageId = await conversation.send(actionsContent, ContentTypeActions);
      logger.success(
        `✅ Actions message sent to ${conversationId}: ${messageId}`
      );

      return messageId;
    } catch (error) {
      logger.error(
        `❌ Failed to send actions message to ${conversationId}:`,
        error
      );
      throw error;
    }
  }

  private async setupClient() {
    const walletKey = this.runtime.getSetting('WALLET_KEY');
    const encryptionKey = this.runtime.getSetting('ENCRYPTION_KEY');
    const signerType = this.runtime.getSetting('XMTP_SIGNER_TYPE');
    const chainId = this.runtime.getSetting('XMTP_SCW_CHAIN_ID');
    const env = this.runtime.getSetting('XMTP_ENV') || 'production';
    const dbPathSetting =
      this.runtime.getSetting('XMTP_DB_PATH') || '/app/data';

    const getDbPath = (env: string, prefix: string = 'xmtp') => {
      if (process.env.BUN_ENV === 'development') {
        return `.data/${prefix}-${env}.db3`;
      }

      // Create database directory if it doesn't exist
      if (!fs.existsSync(dbPathSetting)) {
        fs.mkdirSync(dbPathSetting, { recursive: true });
      }
      const dbPath = `${dbPathSetting}/${prefix}-${env}.db3`;
      console.log('xmtp dbPath:', dbPath);

      return dbPath;
    };

    console.log('xmtp dbPath:', getDbPath(env));

    const signer =
      signerType === 'SCW'
        ? createSCWSigner(walletKey, BigInt(chainId))
        : createEOASigner(walletKey);

    // Convert hex encryption key to bytes for database persistence
    const dbEncryptionKey = encryptionKey
      ? getEncryptionKeyFromHex(encryptionKey)
      : undefined;

    const client = await XmtpClient.create(signer, {
      env,
      dbEncryptionKey,
      dbPath: getDbPath(env),
      codecs: [new ReactionCodec(), new ReplyCodec(), new ActionsCodec(), new IntentCodec()],
    });

    this.client = client;

    logger.success(
      'XMTP client created successfully with inboxId: ',
      this.client.inboxId
    );
    if (dbEncryptionKey) {
      logger.success(
        'Database encryption key configured for persistent installations'
      );
    } else {
      logger.warn(
        'No ENCRYPTION_KEY provided - new installations will be created on each restart'
      );
    }
  }

  private async setupMessageHandler() {
    logger.info('📡 Setting up XMTP message streaming with reply and reaction support...');
    
    this.client.conversations.streamAllMessages(async (err, message) => {
      if (err) {
        logger.error('Error streaming messages', err);
        return;
      }

      // Check if it's from our own inbox
      if (
        message?.senderInboxId.toLowerCase() ===
          this.client.inboxId.toLowerCase()
      ) {
        return;
      }

      // Check content type - support text, reply, reaction, intent, and actions messages
      const contentTypeId = message?.contentType?.typeId;
      if (contentTypeId !== 'text' && contentTypeId !== 'reply' && contentTypeId !== 'reaction' && contentTypeId !== 'intent' && contentTypeId !== 'actions') {
        logger.info(`Skipping message with unsupported content type: ${contentTypeId}`);
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

      logger.success('Waiting for messages...');
    });
  }

  private async processMessage(
    message: DecodedMessage<any>,
    conversation: Conversation
  ) {
    try {
      // Extract text content based on message type
      let text = '';
      let replyReference = undefined;
      let reactionReference = undefined;
      let reactionContent = undefined;
      let reactionAction = undefined;
      let intentData = undefined;
      let actionsData = undefined;
      
      if (message?.contentType?.typeId === 'reply') {
        // Reply message structure: { reference: messageId, contentType: ContentTypeText, content: "text" }
        const replyContent = message?.content;
        text = replyContent?.content ?? '';
        replyReference = replyContent?.reference;
        logger.info(`📩 Processing reply message to ${replyReference}: ${text}`);
        
        // Check if this is a reply to one of the agent's messages
        // This helps the agent know it should respond even in groups
        try {
          const originalMessage = await this.runtime.getMemoryById(stringToUuid(replyReference));
          if (originalMessage?.agentId === this.runtime.agentId) {
            logger.info(`✅ Reply is to agent's message - should respond regardless of mention`);
            // Add agent name to text to trigger mention detection in groups
            // This ensures the agent responds to replies to its messages even without explicit mention
            if (!text.toLowerCase().includes(this.runtime.character.name.toLowerCase())) {
              text = `@${this.runtime.character.name.toLowerCase()} ${text}`;
              logger.info(`📝 Modified text for mention detection: ${text}`);
            } else {
              logger.info(`📝 Text already contains agent mention, no modification needed`);
            }
          } else {
            logger.info(`ℹ️ Reply is to another user's message`);
          }
        } catch (error) {
          logger.warn(`⚠️ Could not check if reply is to agent's message: ${error}`);
        }
      } else if (message?.contentType?.typeId === 'reaction') {
        // Reaction message structure: { reference: messageId, action: "added"/"removed", content: "smile" }
        const reaction = message?.content;
        reactionReference = reaction?.reference;
        reactionAction = reaction?.action;
        reactionContent = reaction?.content;
        text = `reacted with ${reactionContent} (${reactionAction})`;
        logger.info(`😀 Processing reaction to ${reactionReference}: ${reactionContent} (${reactionAction})`);
        
        // Check if this is a reaction to one of the agent's messages
        // This helps the agent know it should respond even in groups
        try {
          const originalMessage = await this.runtime.getMemoryById(stringToUuid(reactionReference));
          if (originalMessage?.agentId === this.runtime.agentId) {
            logger.info(`✅ Reaction is to agent's message - should respond regardless of mention`);
            // Add agent name to text to trigger mention detection in groups for reactions to agent messages
            if (!text.toLowerCase().includes(this.runtime.character.name.toLowerCase())) {
              text = `@${this.runtime.character.name.toLowerCase()} ${text}`;
              logger.info(`📝 Modified reaction text for mention detection: ${text}`);
            } else {
              logger.info(`📝 Reaction text already contains agent mention, no modification needed`);
            }
          } else {
            logger.info(`ℹ️ Reaction is to another user's message`);
          }
        } catch (error) {
          logger.warn(`⚠️ Could not check if reaction is to agent's message: ${error}`);
        }
      } else if (message?.contentType?.typeId === 'intent') {
        // Intent message structure: { id: string, actionId: string, metadata?: {} }
        const intent = message?.content;
        intentData = intent;
        text = `selected action: ${intent?.actionId}`;
        logger.info(`🎯 Processing intent for action: ${intent?.actionId}`);
      } else if (message?.contentType?.typeId === 'actions') {
        // Actions messages are typically sent by agents, not received
        // But we'll handle them gracefully if received
        const actions = message?.content;
        actionsData = actions;
        text = `received actions: ${actions?.description}`;
        logger.info(`📋 Processing actions message: ${actions?.id}`);
      } else {
        // Regular text message
        text = message?.content ?? '';
      }
      const entityId = createUniqueUuid(this.runtime, message.senderInboxId);
      const messageId = stringToUuid(message.id as string);
      const userId = stringToUuid(message.senderInboxId as string);
      const roomId = stringToUuid(message.conversationId as string);

      const channelType = getChannelType(conversation);

      // Resolve Ethereum address for userName to avoid inboxId contamination in conversation context
      let resolvedUserName = message.senderInboxId; // fallback
      try {
        logger.info(
          '🔍 Attempting to resolve address for inboxId:',
          message.senderInboxId
        );
        const inboxStates =
          await this.client.preferences.inboxStateFromInboxIds(
            [message.senderInboxId],
            false
          );
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
        resolvedUserName,
      });

      await this.runtime.ensureConnection({
        entityId,
        userName: resolvedUserName,
        userId,
        roomId,
        channelId: message.conversationId,
        serverId: message.conversationId,
        source: 'xmtp',
        type: channelType,
        worldId: roomId,
      });

      const content: Content = {
        text,
        source: 'xmtp',
        channelType: channelType,
        inReplyTo: replyReference ? stringToUuid(replyReference) : 
                   reactionReference ? stringToUuid(reactionReference) : undefined,
        metadata: {
          senderInboxId: message.senderInboxId,
          senderAddress: resolvedUserName, // Include resolved address for MCP context
          channelId: message.conversationId, // For action handlers to send actions
          serverId: message.conversationId, // Alternative field for action handlers
          conversationId: message.conversationId, // Explicit conversation ID for clarity
          // This ensures MCP tool selection can see the proper Ethereum address
          ...(replyReference && { replyToMessageId: replyReference }),
          ...(reactionReference && { 
            reactionToMessageId: reactionReference,
            reactionContent: reactionContent,
            reactionAction: reactionAction,
            messageType: 'reaction'
          }),
          ...(intentData && {
            intentId: intentData.id,
            actionId: intentData.actionId,
            intentMetadata: intentData.metadata,
            messageType: 'intent'
          }),
          ...(actionsData && {
            actionsId: actionsData.id,
            actionsDescription: actionsData.description,
            actions: actionsData.actions,
            messageType: 'actions'
          }),
        },
      };

      logger.info('📦 Message metadata with resolved address:', {
        senderInboxId: message.senderInboxId,
        senderAddress: resolvedUserName,
        source: 'xmtp',
        isReply: !!replyReference,
        isReaction: !!reactionReference,
        replyToMessageId: replyReference,
        reactionToMessageId: reactionReference,
        reactionContent: reactionContent,
        reactionAction: reactionAction,
        channelType: channelType === ChannelType.DM ? 'DM' : 'GROUP',
      });

      const memory: Memory = {
        id: messageId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content,
      };

      const callback: HandlerCallback = async (
        content: Content,
        _files?: string[]
      ) => {
        try {
          if (!content.text) return [];

          let responseMessageId;
          
          // If the original message was a reply, send our response as a reply too
          if (replyReference) {
            logger.info(`↩️ Sending reply to maintain thread for message: ${message.id}`);
            // Create the reply content structure
            const replyContent = {
              reference: message.id, // Reply to the message we're responding to
              contentType: ContentTypeText,
              content: content.text,
            };
            
            // Send using the reply content type
            responseMessageId = await conversation.send(replyContent, ContentTypeReply);
            logger.info(`✅ Sent threaded reply: ${responseMessageId}`);
          } else {
            // Regular message, send normally
            responseMessageId = await conversation.send(content.text);
          }

          logger.info('💾 [DEBUG] Creating response memory with channelType:', {
            responseMessageId,
            channelType,
            channelTypeString: channelType === ChannelType.DM ? 'DM' : 'GROUP',
            inReplyTo: messageId,
            isThreadedReply: !!replyReference,
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
            },
          };

          await this.runtime.createMemory(responseMemory, 'messages');

          return [responseMemory];
        } catch (error) {
          elizaLogger.error('Error in callback', error);
        }
      };

      this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: 'xmtp',
      });
    } catch (error) {
      elizaLogger.error('Error in onMessage', error);
    }
  }
}
