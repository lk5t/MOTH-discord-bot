import type { ChatInputCommandInteraction, Interaction, InteractionReplyOptions, MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import { MessageFlags } from "discord.js";
import { fail } from "./embeds.js";

export type Repliable = ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;

/** Replies or follows up depending on interaction state. */
export async function respond(i: Repliable, payload: InteractionReplyOptions & { ephemeral?: boolean }): Promise<void> {
  const { ephemeral, ...rest } = payload;
  const opts = { ...rest, flags: ephemeral ? MessageFlags.Ephemeral : undefined } as InteractionReplyOptions;
  if (i.deferred && !i.replied) await i.editReply(rest as never);
  else if (i.replied) await i.followUp(opts);
  else await i.reply(opts);
}

export async function respondError(i: Interaction, message: string): Promise<void> {
  if (!i.isRepliable()) return;
  await respond(i as Repliable, { embeds: [fail(message)], ephemeral: true }).catch(() => undefined);
}

export class UserError extends Error {}

export function relTime(d: Date | number): string {
  return `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>`;
}
