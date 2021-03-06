import * as http from 'http'
import { Container } from 'inversify'
import 'jasmine'
import * as Mail from 'nodemailer/lib/mailer'
import 'reflect-metadata'
import * as winston from 'winston'
import { LoggerInstance } from 'winston'

import { Configuration, configuration } from '../../src/config'

import '../../src/controllers/user.controller'

import { User, UserMetadata } from '../../src/models/user.model'
import { initializeServer } from '../../src/server'
import { DatabaseService } from '../../src/services/database.service'
import { MailService } from '../../src/services/mail.service'
import { TokenService } from '../../src/services/token.service'
import { Services } from '../../src/types'

const request = require('supertest')

type UserWithPassword = User & { password?: string }

class DatabaseServiceMock extends DatabaseService {

  private _users: { [id: string]: UserWithPassword }

  reset() {
    this._users = {
      'john.doe@example.com': {
        name: 'john.doe@example.com',
        roles: [],
        metadata: {
          name: 'John Doe',
          email: 'john.doe@example.com',
        },
        password: 'password',
      },
    }
  }

  async initialize() {
  }

  async getUser(userId: string): Promise<UserWithPassword> {
    return this._users[userId]
  }

  async updateUser(userId: string, data: { metadata: UserMetadata }): Promise<any> {
    this._users[userId].metadata = data.metadata
    return { ok: true }
  }

  async changePassword(userId: string, password: string): Promise<boolean> {
    this._users[userId].password = password
    return true
  }
}

class TokenServiceMock extends TokenService {

  async generateToken(): Promise<{ token: string, hash: string }> {
    return { token: 'fake-token', hash: 'fake-hash' }
  }

  async hashToken(token: string): Promise<string> {
    return token === 'fake-token' ? 'fake-hash' : 'some-other-hash'
  }
}

class MailServiceMock extends MailService {

  public sentMail: Mail.Options

  async sendMail(mail: Mail.Options) {
    this.sentMail = mail
    return {}
  }
}

describe('UserController', () => {

  let nullLogger = new winston.Logger()
  let databaseServiceMock = new DatabaseServiceMock(configuration, nullLogger)
  let tokenServiceMock = new TokenServiceMock()
  let mailServiceMock = new MailServiceMock(configuration, nullLogger)

  let server: http.Server

  beforeEach(async () => {
    databaseServiceMock.reset()

    // load everything needed to the Container
    let container = new Container()

    container.bind<Configuration>(Services.Config).toConstantValue(configuration)
    container.bind<LoggerInstance>(Services.Logger).toConstantValue(nullLogger)
    container.bind<DatabaseService>(Services.Database).toConstantValue(databaseServiceMock)
    container.bind<MailService>(Services.Mail).toConstantValue(mailServiceMock)
    container.bind<TokenService>(Services.Token).toConstantValue(tokenServiceMock)

    server = await initializeServer(Promise.resolve(container))
  })

  afterEach(async () => {
    server.close()
  })

  it('correctly resets password', async () => {
    let userId = 'john.doe@example.com'

    await request(server)
      .get('/user/request-password-reset/' + userId)
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: true })

    expect(mailServiceMock.sentMail.to).toContain(userId)
    let baseUrl = configuration.clientApplication.url
    expect(mailServiceMock.sentMail.text).toContain(
      `${baseUrl}/confirm-password-reset?userId=${userId}&token=fake-token`)

    let user = await databaseServiceMock.getUser(userId)
    let prt = user.metadata['password-reset-token']
    expect(prt).not.toBeNull()
    expect(prt.hash).toEqual('fake-hash')

    await request(server)
      .post('/user/confirm-password-reset/' + userId)
      .send({
        'token': 'fake-token',
        'new-password': 'newPassword',
      })
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: true })

    user = await databaseServiceMock.getUser(userId)
    expect(user.password).toBe('newPassword')
  })

  it('rejects confirmations with invalid token', async () => {
    let userId = 'john.doe@example.com'

    await request(server)
      .get('/user/request-password-reset/' + userId)
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: true })

    await request(server)
      .post('/user/confirm-password-reset/' + userId)
      .send({
        'token': 'invalid-token',
        'new-password': 'newPassword',
      })
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'Token is invalid' })

    let user = await databaseServiceMock.getUser(userId)
    expect(user.password).toBe('password')
  })


  it('rejects confirmations with expired token', async () => {
    let userId = 'john.doe@example.com'

    await request(server)
      .get('/user/request-password-reset/' + userId)
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: true })

    // Tamper with token's expiry date !
    let user = await databaseServiceMock.getUser(userId)
    user.metadata['password-reset-token'].expiryDate = new Date().toISOString()
    await databaseServiceMock.updateUser(userId, user)

    await request(server)
      .post('/user/confirm-password-reset/' + userId)
      .send({
        'token': 'invalid-token',
        'new-password': 'newPassword',
      })
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'Token has expired' })

    user = await databaseServiceMock.getUser(userId)
    expect(user.password).toBe('password')
  })

  it('rejects requests for unknown users', async () => {
    let userId = 'jane.smith@example.com'

    await request(server)
      .get('/user/request-password-reset/' + userId)
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'Unknown user' })
  })

  it('rejects confirmations for unknown users', async () => {
    let userId = 'jane.smith@example.com'

    await request(server)
      .post('/user/confirm-password-reset/' + userId)
      .send({
        'token': 'fake-token',
        'new-password': 'newPassword',
      })
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'Unknown user' })
  })

  it('rejects confirmations without prior request', async () => {
    let userId = 'john.doe@example.com'

    await request(server)
      .post('/user/confirm-password-reset/' + userId)
      .send({
        'token': 'fake-token',
        'new-password': 'newPassword',
      })
      .expect(200)
      .expect('Content-Type', 'application/json; charset=utf-8')
      .expect({ ok: false, error: 'No password reset request done' })
  })
})
