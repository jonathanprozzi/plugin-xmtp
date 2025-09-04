import {
  ContentTypeId,
  type ContentCodec,
  type EncodedContent,
} from '@xmtp/content-type-primitives'

export const ContentTypeIntent = new ContentTypeId({
  authorityId: 'xmtp.org',
  typeId: 'intent',
  versionMajor: 1,
  versionMinor: 0,
})

export interface IntentContent {
  id: string
  actionId: string
  metadata?: Record<string, any>
}

export class IntentCodec implements ContentCodec<IntentContent> {
  get contentType(): ContentTypeId {
    return ContentTypeIntent
  }

  encode(content: IntentContent): EncodedContent {
    return {
      type: ContentTypeIntent,
      parameters: {},
      content: new TextEncoder().encode(JSON.stringify(content)),
    }
  }

  decode(content: EncodedContent): IntentContent {
    const decoded = new TextDecoder().decode(content.content)
    return JSON.parse(decoded)
  }

  fallback(content: IntentContent): string {
    return `Selected action: ${content.actionId}`
  }

  shouldPush(): boolean {
    return true
  }
}