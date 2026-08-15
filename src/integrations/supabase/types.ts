export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      clientes_oem: {
        Row: {
          bloqueado: boolean | null
          cnpj_cpf: string
          created_at: string
          custo_total: number | null
          empresa_codigo: string
          filial_codigo: string
          grupo_economico: string | null
          id: string
          last_sync: string | null
          licencas_detalhe: Json | null
          modulos_ativos: Json | null
          motivo_bloqueio: string | null
          nome_fantasia: string
          numero_filiais: number | null
          produto_principal: string | null
          qtd_comandas: number
          qtd_pdv: number
          qtd_pdv_comandas: number | null
          razao_social: string | null
          status: string | null
          tenant_id: string
          updated_at: string
          usuarios_adicionais: number | null
        }
        Insert: {
          bloqueado?: boolean | null
          cnpj_cpf: string
          created_at?: string
          custo_total?: number | null
          empresa_codigo: string
          filial_codigo: string
          grupo_economico?: string | null
          id?: string
          last_sync?: string | null
          licencas_detalhe?: Json | null
          modulos_ativos?: Json | null
          motivo_bloqueio?: string | null
          nome_fantasia: string
          numero_filiais?: number | null
          produto_principal?: string | null
          qtd_comandas?: number
          qtd_pdv?: number
          qtd_pdv_comandas?: number | null
          razao_social?: string | null
          status?: string | null
          tenant_id: string
          updated_at?: string
          usuarios_adicionais?: number | null
        }
        Update: {
          bloqueado?: boolean | null
          cnpj_cpf?: string
          created_at?: string
          custo_total?: number | null
          empresa_codigo?: string
          filial_codigo?: string
          grupo_economico?: string | null
          id?: string
          last_sync?: string | null
          licencas_detalhe?: Json | null
          modulos_ativos?: Json | null
          motivo_bloqueio?: string | null
          nome_fantasia?: string
          numero_filiais?: number | null
          produto_principal?: string | null
          qtd_comandas?: number
          qtd_pdv?: number
          qtd_pdv_comandas?: number | null
          razao_social?: string | null
          status?: string | null
          tenant_id?: string
          updated_at?: string
          usuarios_adicionais?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "clientes_oem_tenant_fk"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      developer_gateways: {
        Row: {
          api_token_hash: string | null
          client_id: string | null
          created_at: string | null
          id: string
          webhook_events: string[] | null
          webhook_url: string | null
        }
        Insert: {
          api_token_hash?: string | null
          client_id?: string | null
          created_at?: string | null
          id?: string
          webhook_events?: string[] | null
          webhook_url?: string | null
        }
        Update: {
          api_token_hash?: string | null
          client_id?: string | null
          created_at?: string | null
          id?: string
          webhook_events?: string[] | null
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "developer_gateways_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clientes_oem"
            referencedColumns: ["id"]
          },
        ]
      }
      oem_api_chaves: {
        Row: {
          ativa: boolean
          criada_em: string
          criada_por: string | null
          id: string
          nome: string
          prefixo: string
          revogada_em: string | null
          tenant_id: string
          token_hash: string
          ultimo_uso_em: string | null
        }
        Insert: {
          ativa?: boolean
          criada_em?: string
          criada_por?: string | null
          id?: string
          nome: string
          prefixo: string
          revogada_em?: string | null
          tenant_id: string
          token_hash: string
          ultimo_uso_em?: string | null
        }
        Update: {
          ativa?: boolean
          criada_em?: string
          criada_por?: string | null
          id?: string
          nome?: string
          prefixo?: string
          revogada_em?: string | null
          tenant_id?: string
          token_hash?: string
          ultimo_uso_em?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "oem_api_chaves_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      oem_sync_config: {
        Row: {
          ativo: boolean
          id: number
          intervalo_horas: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          ativo?: boolean
          id?: number
          intervalo_horas?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          ativo?: boolean
          id?: number
          intervalo_horas?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "oem_sync_config_tenant_fk"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      oem_sync_fila: {
        Row: {
          criado_em: string
          empresa_codigo: string
          erro: string | null
          filial_codigo: string
          id: number
          numero_filiais: number | null
          processado_em: string | null
          produto: string | null
          resumo: Json | null
          run_id: string
          status: string
          tenant_id: string
          tentativas: number
        }
        Insert: {
          criado_em?: string
          empresa_codigo: string
          erro?: string | null
          filial_codigo: string
          id?: number
          numero_filiais?: number | null
          processado_em?: string | null
          produto?: string | null
          resumo?: Json | null
          run_id: string
          status?: string
          tenant_id: string
          tentativas?: number
        }
        Update: {
          criado_em?: string
          empresa_codigo?: string
          erro?: string | null
          filial_codigo?: string
          id?: number
          numero_filiais?: number | null
          processado_em?: string | null
          produto?: string | null
          resumo?: Json | null
          run_id?: string
          status?: string
          tenant_id?: string
          tentativas?: number
        }
        Relationships: [
          {
            foreignKeyName: "oem_sync_fila_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "oem_sync_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oem_sync_fila_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      oem_sync_logs: {
        Row: {
          clientes_atualizados: number
          clientes_falha: number
          duracao_ms: number | null
          executado_em: string
          id: string
          mensagem: string | null
          origem: string
          status: string
          tenant_id: string
          total_clientes: number
        }
        Insert: {
          clientes_atualizados?: number
          clientes_falha?: number
          duracao_ms?: number | null
          executado_em?: string
          id?: string
          mensagem?: string | null
          origem?: string
          status: string
          tenant_id: string
          total_clientes?: number
        }
        Update: {
          clientes_atualizados?: number
          clientes_falha?: number
          duracao_ms?: number | null
          executado_em?: string
          id?: string
          mensagem?: string | null
          origem?: string
          status?: string
          tenant_id?: string
          total_clientes?: number
        }
        Relationships: [
          {
            foreignKeyName: "oem_sync_logs_tenant_fk"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      oem_sync_runs: {
        Row: {
          atualizado_em: string
          atualizados: number
          enfileirados: number
          erro: string | null
          falhas: number
          fase: string
          finalizado_em: string | null
          grupos_lidos: number
          id: string
          iniciado_em: string
          inseridos: number
          log_id: string | null
          origem: string
          processados: number
          produtos: Json | null
          proxima_pagina: number
          tenant_id: string
          total_registros: number | null
        }
        Insert: {
          atualizado_em?: string
          atualizados?: number
          enfileirados?: number
          erro?: string | null
          falhas?: number
          fase?: string
          finalizado_em?: string | null
          grupos_lidos?: number
          id?: string
          iniciado_em?: string
          inseridos?: number
          log_id?: string | null
          origem?: string
          processados?: number
          produtos?: Json | null
          proxima_pagina?: number
          tenant_id: string
          total_registros?: number | null
        }
        Update: {
          atualizado_em?: string
          atualizados?: number
          enfileirados?: number
          erro?: string | null
          falhas?: number
          fase?: string
          finalizado_em?: string | null
          grupos_lidos?: number
          id?: string
          iniciado_em?: string
          inseridos?: number
          log_id?: string | null
          origem?: string
          processados?: number
          produtos?: Json | null
          proxima_pagina?: number
          tenant_id?: string
          total_registros?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "oem_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      oem_token_cache: {
        Row: {
          atualizado_em: string
          cooldown_ate: string | null
          expira_em: string | null
          tenant_id: string
          token: string | null
        }
        Insert: {
          atualizado_em?: string
          cooldown_ate?: string | null
          expira_em?: string | null
          tenant_id: string
          token?: string | null
        }
        Update: {
          atualizado_em?: string
          cooldown_ate?: string | null
          expira_em?: string | null
          tenant_id?: string
          token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "oem_token_cache_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          full_name: string | null
          id: string
          is_active: boolean
          role: Database["public"]["Enums"]["user_role"] | null
          updated_at: string | null
        }
        Insert: {
          full_name?: string | null
          id: string
          is_active?: boolean
          role?: Database["public"]["Enums"]["user_role"] | null
          updated_at?: string | null
        }
        Update: {
          full_name?: string | null
          id?: string
          is_active?: boolean
          role?: Database["public"]["Enums"]["user_role"] | null
          updated_at?: string | null
        }
        Relationships: []
      }
      tenant_members: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_members_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_oem_settings: {
        Row: {
          oem_api_base_url: string | null
          oem_api_method: string | null
          oem_api_password: string | null
          oem_api_username: string | null
          oem_client_id: string | null
          oem_client_secret: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          oem_api_base_url?: string | null
          oem_api_method?: string | null
          oem_api_password?: string | null
          oem_api_username?: string | null
          oem_client_id?: string | null
          oem_client_secret?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          oem_api_base_url?: string | null
          oem_api_method?: string | null
          oem_api_password?: string | null
          oem_api_username?: string | null
          oem_client_id?: string | null
          oem_client_secret?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_oem_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          ativo: boolean
          cnpj: string | null
          created_at: string
          id: string
          nome: string
          slug: string
          updated_at: string
        }
        Insert: {
          ativo?: boolean
          cnpj?: string | null
          created_at?: string
          id?: string
          nome: string
          slug: string
          updated_at?: string
        }
        Update: {
          ativo?: boolean
          cnpj?: string | null
          created_at?: string
          id?: string
          nome?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webhook_logs: {
        Row: {
          created_at: string
          event_type: string
          gateway_id: string | null
          id: string
          payload: Json
          response_status: number | null
        }
        Insert: {
          created_at?: string
          event_type: string
          gateway_id?: string | null
          id?: string
          payload?: Json
          response_status?: number | null
        }
        Update: {
          created_at?: string
          event_type?: string
          gateway_id?: string | null
          id?: string
          payload?: Json
          response_status?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_logs_gateway_id_fkey"
            columns: ["gateway_id"]
            isOneToOne: false
            referencedRelation: "developer_gateways"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_tenant_access: {
        Args: { _tenant_id: string; _user_id: string }
        Returns: boolean
      }
      is_super_admin: { Args: never; Returns: boolean }
      is_tenant_admin: {
        Args: { _tenant_id: string; _user_id: string }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "super_admin"
      tenant_role: "admin" | "financeiro" | "suporte"
      user_role: "admin" | "financeiro" | "suporte"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["super_admin"],
      tenant_role: ["admin", "financeiro", "suporte"],
      user_role: ["admin", "financeiro", "suporte"],
    },
  },
} as const
