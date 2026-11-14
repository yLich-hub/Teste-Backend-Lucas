import { errorInfo, JsonLogger } from '../observability/logger';

/**
 * Loop simples "executa, espera, executa". `tick` devolve true quando há mais
 * trabalho pendente (roda de novo sem esperar). `stop` espera o tick atual
 * terminar — importante para o shutdown gracioso.
 */
export class PeriodicWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: JsonLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let hasMore = false;
      try {
        hasMore = await this.tick();
      } catch (err) {
        this.logger.warn(`${this.name} tick failed`, errorInfo(err));
      }
      if (!hasMore && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
