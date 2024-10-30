import { Notification } from 'firebase-admin/messaging'
import { DeepPartial, FindOptionsWhere, In } from 'typeorm'
import { Profile } from '../entity/profile'
import { StatusType, User } from '../entity/user'
import { redisDataSource } from '../redis_data_source'
import { authTrx, getRepository, queryBuilderToRawSql } from '../repository'
import { userRepository } from '../repository/user'
import { SetClaimsRole } from '../utils/dictionary'
import { logger } from '../utils/logger'
import {
  PushNotificationType,
  sendMulticastPushNotifications,
} from '../utils/sendNotification'
import { findDeviceTokensByUserId } from './user_device_tokens'

export const deleteUser = async (userId: string) => {
  await authTrx(
    async (t) => {
      await t.withRepository(userRepository).delete(userId)
    },
    {
      uid: userId,
    }
  )
}

export const updateUser = async (userId: string, update: Partial<User>) => {
  return authTrx(async (t) => t.getRepository(User).update(userId, update), {
    uid: userId,
  })
}

export const softDeleteUser = async (userId: string) => {
  return authTrx(
    async (t) => {
      // change email address and username for user to sign up again
      await t.getRepository(Profile).update(
        {
          user: {
            id: userId,
          },
        },
        {
          username: `deleted_user_${userId}`,
        }
      )

      return t.getRepository(User).update(userId, {
        status: StatusType.Deleted,
        email: `deleted_user_${userId}@omnivore.app`,
        sourceUserId: `deleted_user_${userId}`,
      })
    },
    {
      uid: userId,
    }
  )
}

export const findActiveUser = async (id: string): Promise<User | null> => {
  return userRepository.findOneBy({ id, status: StatusType.Active })
}

export const findUsersByIds = async (ids: string[]): Promise<User[]> => {
  return userRepository.findBy({ id: In(ids) })
}

export const deleteUsers = async (
  criteria: FindOptionsWhere<User> | string[]
) => {
  return authTrx(async (t) => t.getRepository(User).delete(criteria), {
    userRole: SetClaimsRole.ADMIN,
  })
}

export const createUsers = async (users: DeepPartial<User>[]) => {
  return authTrx(async (t) => t.getRepository(User).save(users), {
    userRole: SetClaimsRole.ADMIN,
  })
}

export const batchDelete = async (criteria: FindOptionsWhere<User>) => {
  const userQb = getRepository(User).createQueryBuilder().where(criteria)
  const batchSize = 100
  const userSubQuery = queryBuilderToRawSql(userQb.select('id').take(batchSize))

  const sql = `
  DO $$
  BEGIN
      LOOP
          DELETE FROM omnivore.user
          WHERE id IN (${userSubQuery});

          EXIT WHEN NOT FOUND;

          -- Avoid overwhelming the server
          PERFORM pg_sleep(0.1);
      END LOOP;
  END $$
  `

  return authTrx(async (t) => t.query(sql), {
    userRole: SetClaimsRole.ADMIN,
  })
}

export const sendPushNotifications = async (
  userId: string,
  notification: Notification,
  notificationType: PushNotificationType,
  data?: { [key: string]: string }
) => {
  const tokens = await findDeviceTokensByUserId(userId)
  if (tokens.length === 0) {
    logger.info(`No device tokens found for user ${userId}`)
    return
  }

  const message = {
    notification,
    data,
    tokens: tokens.map((token) => token.token),
  }

  return sendMulticastPushNotifications(userId, message, notificationType)
}

export const findUserAndPersonalization = async (id: string) => {
  return authTrx(
    (t) =>
      t.getRepository(User).findOne({
        where: { id },
        relations: {
          userPersonalization: true,
        },
      }),
    {
      uid: id,
    }
  )
}

const userCacheKey = (id: string) => `cache:user:${id}`

export const getCachedUser = async (id: string) => {
  const user = await redisDataSource.redisClient?.get(userCacheKey(id))
  if (!user) {
    return undefined
  }

  return JSON.parse(user) as User
}

export const cacheUser = async (user: User) => {
  await redisDataSource.redisClient?.set(
    userCacheKey(user.id),
    JSON.stringify(user),
    'EX',
    600
  )
}
