import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * PONTO DE EXTENSÃO DE AUTENTICAÇÃO (intencionalmente no-op).
 *
 * Decisão documentada no ARCHITECTURE.md: autenticação não vale pontos no
 * desafio, então não foi implementada. O desenho previsto:
 *  - Keycloak (OIDC) como Identity Provider, um client por provedor de jogos
 *    (client_credentials);
 *  - este guard valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`);
 *  - o `azp`/claim `provider_id` do token deve ser IGUAL ao `providerId` do
 *    body — um provedor não pode lançar transações em nome de outro.
 *
 * Os endpoints de health/metrics não usam este guard.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
