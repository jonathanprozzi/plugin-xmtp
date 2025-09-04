import {
  ContentTypeId,
  type ContentCodec,
  type EncodedContent,
} from '@xmtp/content-type-primitives'

export const ContentTypeActions = new ContentTypeId({
  authorityId: 'xmtp.org',
  typeId: 'actions',
  versionMajor: 1,
  versionMinor: 0,
})

export interface Action {
  id: string
  label: string
  imageUrl?: string
  style?: 'primary' | 'secondary' | 'danger'
  expiresAt?: string
}

export interface ActionsContent {
  id: string
  description: string
  actions: Action[]
  expiresAt?: string
}

export class ActionsCodec implements ContentCodec<ActionsContent> {
  get contentType(): ContentTypeId {
    return ContentTypeActions
  }

  encode(content: ActionsContent): EncodedContent {
    return {
      type: ContentTypeActions,
      parameters: {},
      content: new TextEncoder().encode(JSON.stringify(content)),
    }
  }

  decode(content: EncodedContent): ActionsContent {
    const decoded = new TextDecoder().decode(content.content)
    return JSON.parse(decoded)
  }

  fallback(content: ActionsContent): string {
    const actionsList = content.actions
      .map((action) => `• ${action.label}`)
      .join('\n')
    return `${content.description}\n\n${actionsList}`
  }

  shouldPush(): boolean {
    return true
  }
}