import { TransientError } from '../../application/errors';

/** Atualização perdeu a corrida (versão mudou). É transitório: basta tentar de novo. */
export class ConcurrencyError extends TransientError {}
