import axios from 'axios'
import jwt from 'jsonwebtoken'
import { promisify } from 'util'
import { env } from '../env'
import { redisDataSource } from '../redis_data_source'

const signToken = promisify(jwt.sign)

const IMPORTER_METRICS_COLLECTOR_URL = env.queue.importerMetricsUrl
const JWT_SECRET = env.server.jwtSecret
const REST_BACKEND_ENDPOINT = `${env.server.internalApiUrl}/api`

const MAX_ATTEMPTS = 2
const REQUEST_TIMEOUT = 30000 // 30 seconds

interface Data {
  userId: string
  url: string
  articleSavingRequestId: string
  state?: string
  labels?: string[]
  source: string
  folder: string
  rssFeedUrl?: string
  savedAt?: string
  publishedAt?: string
  taskId?: string
}

interface UploadFileResponse {
  data: {
    uploadFileRequest: {
      id: string
      uploadSignedUrl: string
      uploadFileId: string
      createdPageId: string
      errorCodes?: string[]
    }
  }
}

interface CreateArticleResponse {
  data: {
    createArticle: {
      createdArticle: {
        id: string
      }
      errorCodes: string[]
    }
  }
}

interface SavePageResponse {
  data: {
    savePage: {
      url: string
      clientRequestId: string
      errorCodes?: string[]
    }
  }
}

interface FetchResult {
  finalUrl: string
  title: string
  content?: string
  contentType?: string
  readabilityResult?: unknown
}

const isFetchResult = (obj: unknown): obj is FetchResult => {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'finalUrl' in obj &&
    'title' in obj
  )
}

const uploadToSignedUrl = async (
  uploadSignedUrl: string,
  contentType: string,
  contentObjUrl: string
) => {
  try {
    const stream = await axios.get(contentObjUrl, {
      responseType: 'stream',
      timeout: REQUEST_TIMEOUT,
    })
    return axios.put(uploadSignedUrl, stream.data, {
      headers: {
        'Content-Type': contentType,
      },
      maxBodyLength: 1000000000,
      maxContentLength: 100000000,
      timeout: REQUEST_TIMEOUT,
    })
  } catch (error) {
    console.error('error uploading to signed url', error)
    return null
  }
}

const getUploadIdAndSignedUrl = async (
  userId: string,
  url: string,
  articleSavingRequestId: string
) => {
  const auth = await signToken({ uid: userId }, JWT_SECRET)
  const data = JSON.stringify({
    query: `mutation UploadFileRequest($input: UploadFileRequestInput!) {
      uploadFileRequest(input:$input) {
        ... on UploadFileRequestError {
          errorCodes
        }
        ... on UploadFileRequestSuccess {
          id
          uploadSignedUrl
        }
      }
    }`,
    variables: {
      input: {
        url,
        contentType: 'application/pdf',
        clientRequestId: articleSavingRequestId,
      },
    },
  })

  try {
    const response = await axios.post<UploadFileResponse>(
      `${REST_BACKEND_ENDPOINT}/graphql`,
      data,
      {
        headers: {
          Cookie: `auth=${auth as string};`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT,
      }
    )

    if (
      response.data.data.uploadFileRequest.errorCodes &&
      response.data.data.uploadFileRequest.errorCodes?.length > 0
    ) {
      console.error(
        'Error while getting upload id and signed url',
        response.data.data.uploadFileRequest.errorCodes[0]
      )
      return null
    }

    return response.data.data.uploadFileRequest
  } catch (e) {
    console.error('error getting upload id and signed url', e)
    return null
  }
}

const uploadPdf = async (
  url: string,
  userId: string,
  articleSavingRequestId: string
) => {
  const uploadResult = await getUploadIdAndSignedUrl(
    userId,
    url,
    articleSavingRequestId
  )
  if (!uploadResult) {
    throw new Error('error while getting upload id and signed url')
  }
  const uploaded = await uploadToSignedUrl(
    uploadResult.uploadSignedUrl,
    'application/pdf',
    url
  )
  if (!uploaded) {
    throw new Error('error while uploading pdf')
  }
  return uploadResult.id
}

const sendCreateArticleMutation = async (userId: string, input: unknown) => {
  const data = JSON.stringify({
    query: `mutation CreateArticle ($input: CreateArticleInput!){
          createArticle(input:$input){
            ... on CreateArticleSuccess{
              createdArticle{
                id
            }
        }
          ... on CreateArticleError{
              errorCodes
          }
      }
    }`,
    variables: {
      input,
    },
  })

  const auth = await signToken({ uid: userId }, JWT_SECRET)
  try {
    const response = await axios.post<CreateArticleResponse>(
      `${REST_BACKEND_ENDPOINT}/graphql`,
      data,
      {
        headers: {
          Cookie: `auth=${auth as string};`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT,
      }
    )

    if (
      response.data.data.createArticle.errorCodes &&
      response.data.data.createArticle.errorCodes.length > 0
    ) {
      console.error(
        'error while creating article',
        response.data.data.createArticle.errorCodes[0]
      )
      return null
    }

    return response.data.data.createArticle
  } catch (error) {
    console.error('error creating article', error)
    return null
  }
}

const sendSavePageMutation = async (userId: string, input: unknown) => {
  const data = JSON.stringify({
    query: `mutation SavePage ($input: SavePageInput!){
          savePage(input:$input){
            ... on SaveSuccess{
              url
              clientRequestId
            }
            ... on SaveError{
                errorCodes
            }
          }
    }`,
    variables: {
      input,
    },
  })

  const auth = await signToken({ uid: userId }, JWT_SECRET)
  try {
    const response = await axios.post<SavePageResponse>(
      `${REST_BACKEND_ENDPOINT}/graphql`,
      data,
      {
        headers: {
          Cookie: `auth=${auth as string};`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT,
      }
    )

    if (
      response.data.data.savePage.errorCodes &&
      response.data.data.savePage.errorCodes.length > 0
    ) {
      console.error(
        'error while saving page',
        response.data.data.savePage.errorCodes[0]
      )
      if (response.data.data.savePage.errorCodes[0] === 'UNAUTHORIZED') {
        return { error: 'UNAUTHORIZED' }
      }

      return null
    }

    return response.data.data.savePage
  } catch (error) {
    console.error('error saving page', error)
    return null
  }
}

const sendImportStatusUpdate = async (
  userId: string,
  taskId: string,
  isImported?: boolean
) => {
  try {
    const auth = await signToken({ uid: userId }, JWT_SECRET)

    await axios.post(
      IMPORTER_METRICS_COLLECTOR_URL,
      {
        taskId,
        status: isImported ? 'imported' : 'failed',
      },
      {
        headers: {
          Authorization: auth as string,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT,
      }
    )
  } catch (e) {
    console.error('error while sending import status update', e)
  }
}

const getCachedFetchResult = async (url: string) => {
  const key = `fetch-result:${url}`
  if (!redisDataSource.redisClient) {
    throw new Error('redis client is not initialized')
  }

  const result = await redisDataSource.redisClient.get(key)
  if (!result) {
    throw new Error('fetch result is not cached')
  }

  const fetchResult = JSON.parse(result) as unknown
  if (!isFetchResult(fetchResult)) {
    throw new Error('fetch result is not valid')
  }

  console.log('fetch result is cached', url)

  return fetchResult
}

export const savePageJob = async (data: Data, attemptsMade: number) => {
  const {
    userId,
    articleSavingRequestId,
    state,
    labels,
    source,
    folder,
    rssFeedUrl,
    savedAt,
    publishedAt,
    taskId,
  } = data
  let isImported, isSaved

  try {
    const url = encodeURI(data.url)

    // get the fetch result from cache
    const { title, content, contentType, readabilityResult } =
      await getCachedFetchResult(url)

    // for pdf content, we need to upload the pdf
    if (contentType === 'application/pdf') {
      const uploadFileId = await uploadPdf(url, userId, articleSavingRequestId)
      const uploadedPdf = await sendCreateArticleMutation(userId, {
        url,
        articleSavingRequestId,
        uploadFileId,
        state,
        labels,
        source,
        folder,
        rssFeedUrl,
        savedAt,
        publishedAt,
      })
      if (!uploadedPdf) {
        throw new Error('error while saving uploaded pdf')
      }

      isSaved = true
      isImported = true
      return true
    }

    // for non-pdf content, we need to save the page
    const apiResponse = await sendSavePageMutation(userId, {
      url,
      clientRequestId: articleSavingRequestId,
      title,
      originalContent: content,
      parseResult: readabilityResult,
      state,
      labels,
      rssFeedUrl,
      savedAt,
      publishedAt,
      source,
      folder,
    })
    if (!apiResponse) {
      throw new Error('error while saving page')
    }

    if ('error' in apiResponse && apiResponse.error === 'UNAUTHORIZED') {
      console.log('user is deleted', userId)
      return false
    }

    // if the readability result is not parsed, the import is failed
    isImported = !!readabilityResult
    isSaved = true
  } catch (e) {
    if (e instanceof Error) {
      console.error('error while saving page', e.message)
    } else {
      console.error('error while saving page', 'unknown error')
    }

    throw e
  } finally {
    const lastAttempt = attemptsMade === MAX_ATTEMPTS - 1
    if (lastAttempt) {
      console.log('last attempt reached', data.url)
    }

    if (taskId && (isSaved || lastAttempt)) {
      // send import status to update the metrics for importer
      await sendImportStatusUpdate(userId, taskId, isImported)
    }
  }

  return true
}