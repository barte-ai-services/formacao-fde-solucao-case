/** Execução agendada. Por enquanto só registra que rodou, sem dado sensível. */
export function tick(controller: Pick<ScheduledController, "cron">): void {
  console.log(`cron: execução agendada (${controller.cron})`);
}
