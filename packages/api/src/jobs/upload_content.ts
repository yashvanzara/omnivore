import { Highlight } from '../entity/highlight'
import { findLibraryItemById } from '../services/library_item'
import { logger } from '../utils/logger'
import { htmlToHighlightedMarkdown, htmlToMarkdown } from '../utils/parser'
import { isFileExists, uploadToBucket } from '../utils/uploads'

export const UPLOAD_CONTENT_JOB = 'upload-content'

export type ContentFormat =
  | 'markdown'
  | 'highlightedMarkdown'
  | 'original'
  | 'readable'

export interface UploadContentJobData {
  libraryItemId: string
  userId: string
  format: ContentFormat
  filePath: string
  content?: string
}

const convertContent = (
  content: string,
  format: ContentFormat,
  highlights?: Highlight[]
): string => {
  switch (format) {
    case 'markdown':
      return htmlToMarkdown(content)
    case 'highlightedMarkdown':
      return htmlToHighlightedMarkdown(content, highlights)
    case 'original':
    case 'readable':
      return content
    default:
      throw new Error('Unsupported format')
  }
}

const CONTENT_TYPES = {
  markdown: 'text/markdown',
  highlightedMarkdown: 'text/markdown',
  original: 'text/html',
  readable: 'text/html',
}

export const uploadContentJob = async (data: UploadContentJobData) => {
  logger.info('Uploading content to bucket', data)

  const { libraryItemId, userId, format, filePath } = data

  const libraryItem = await findLibraryItemById(libraryItemId, userId, {
    select: ['id', 'readableContent'], // id is required for relations
    relations: {
      highlights: format === 'highlightedMarkdown',
    },
  })
  if (!libraryItem) {
    logger.error(`Library item not found: ${libraryItemId}`)
    throw new Error('Library item not found')
  }

  const content = libraryItem.readableContent

  if (!content) {
    logger.error(`content not found`)
    throw new Error('Content not found')
  }

  logger.info('Converting content')
  const convertedContent = convertContent(
    content,
    format,
    libraryItem.highlights
  )

  const exists = await isFileExists(filePath)
  if (exists) {
    logger.info(`File already exists: ${filePath}`)
    return
  }

  logger.info(`Uploading content: ${filePath}`)
  logger.profile('Uploader')

  await uploadToBucket(filePath, Buffer.from(convertedContent), {
    contentType: CONTENT_TYPES[format],
    timeout: 10_000, // 10 seconds
  })

  logger.profile('Uploader', {
    level: 'info',
    message: 'Content uploaded',
  })
}
