declare module "email-reply-parser" {
  class Email {
    getVisibleText(): string;
    getFragments(): unknown[];
  }
  export default class EmailReplyParser {
    read(text: string): Email;
  }
}
