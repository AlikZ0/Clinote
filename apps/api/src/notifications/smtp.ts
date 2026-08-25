/** SMTP sender. Mailpit in development, a real provider in production. */
import { createTransport } from 'nodemailer'
import type { EmailMessage, EmailSender } from './senders'

export interface SmtpOptions {
  host: string
  port: number
  secure?: boolean
  user?: string
  password?: string
  from: string
}

export function createSmtpEmailSender(options: SmtpOptions): EmailSender {
  const transport = createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure ?? false,
    auth: options.user ? { user: options.user, pass: options.password ?? '' } : undefined,
  })

  return {
    async send(message: EmailMessage): Promise<void> {
      await transport.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      })
    },
  }
}
