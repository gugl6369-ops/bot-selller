import type { Context } from 'grammy';

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply([
    'Доступные команды:',
    '/start — начать работу с ботом',
    '/help — показать эту справку',
  ].join('\n'));
}
