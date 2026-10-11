/** Tipos da api-tenant (spec 0017): empresa (tenant), usuários ligados a ela e dados bancários. */

export const PAPEIS = ["admin", "operacao"] as const;
export type Papel = (typeof PAPEIS)[number];

export const TIPOS_EMPRESA = ["cliente", "interno"] as const;
export type TipoEmpresa = (typeof TIPOS_EMPRESA)[number];

export interface Empresa {
  id: number;
  slug: string;
  nome: string;
  cnpj: string | null;
  tipo: TipoEmpresa;
  ativo: boolean;
}

/** Vínculo em tenant_membros. */
export interface Vinculo {
  tenant_id: number;
  user_id: string;
  papel: Papel;
  ativo: boolean;
}

export interface Membro {
  user_id: string;
  email: string | null;
  papel: Papel;
  ativo: boolean;
}

export interface DadosRestritos {
  banco: string | null;
  agencia: string | null;
  conta: string | null;
  updated_at: string | null;
}

export interface Usuario {
  id: string;
  email: string | null;
  /** app_metadata.licitagym_role = 'admin' na conta. */
  desenvolvedor: boolean;
}

/** Ações que exigem ser ADMIN da empresa (o desenvolvedor conta como admin de qualquer empresa, decisão 3). */
export const ACOES_ADMIN = new Set([
  "empresa_atualizar", "membro_adicionar", "membro_atualizar", "dados_restritos_obter", "dados_restritos_salvar",
]);

export type Acao =
  | { action: "minha_empresa" }
  | { action: "cnpj_consultar"; cnpj: string }
  | { action: "empresa_criar"; cnpj: string; admin_email: string; nome: string | null; slug: string | null; tipo: TipoEmpresa }
  | { action: "empresa_atualizar"; tenant_id: number; nome?: string; cnpj?: string; ativo?: boolean }
  | { action: "membros_listar"; tenant_id: number }
  | { action: "membro_adicionar"; tenant_id: number; email: string; papel: Papel }
  | { action: "membro_atualizar"; tenant_id: number; user_id: string; papel?: Papel; ativo?: boolean }
  | { action: "dados_restritos_obter"; tenant_id: number }
  | {
    action: "dados_restritos_salvar";
    tenant_id: number;
    /** Só os campos enviados são gravados; os demais ficam como estão. */
    campos: Partial<Pick<DadosRestritos, "banco" | "agencia" | "conta">>;
  };
