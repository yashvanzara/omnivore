import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'
import { User } from './user'

@Entity({ name: 'post' })
export class Post {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('uuid')
  userId!: string

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User

  @Column('uuid', { array: true })
  libraryItemIds!: string[]

  @Column('uuid', { array: true, nullable: true })
  highlightIds?: string[] | null

  @Column('text')
  title!: string

  @Column('text')
  content!: string

  @Column('text', { nullable: true })
  thumbnail?: string | null

  @Column('text', { nullable: true })
  thought?: string | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date
}
