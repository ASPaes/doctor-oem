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
  public: {
    Tables: {
      clientes_oem: {
        Row: {
          bloqueado: boolean | null
          cnpj_cpf: string
          created_at: string
          custo_total: number | null
          empresa_codigo: string | null
          filial_codigo: string | null
          grupo_economico: string | null
          id: string
          last_sync: string | null
          licencas_detalhe: Json | null
          modulos_ativos: Json | null
          motivo_bloqueio: string | null
          nome_fantasia: string
          numero_filiais: number | null
          produto_principal: string | null
          qtd_comandas: number | null
          qtd_pdv: number | null
          qtd_pdv_comandas: number | null
          razao_social: string | null
          status: string | null
          tenant_id: string
          updated_at: string
          usuarios_adicionais: number | null
        }
        Insert: {
          bloqueado?: boolean | null
          cnpj_cpf?: string
          created_at?: string
          custo_total?: number | null
          empresa_codigo?: string | null
          filial_codigo?: string | null
          grupo_economico?: string | null
          id?: string
          last_sync?: string | null
          licencas_detalhe?: Json | null
          modulos_ativos?: Json | null
          motivo_bloqueio?: string | null
          nome_fantasia: string
          numero_filiais?: number | null
          produto_principal?: string | null
          qtd_comandas?: number | null
          qtd_pdv?: number | null
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
          empresa_codigo?: string | null
          filial_codigo?: string | null
          grupo_economico?: string | null
          id?: string
          last_sync?: string | null
          licencas_detalhe?: Json | null
          modulos_ativos?: Json | null
          motivo_bloqueio?: string | null
          nome_fantasia?: string
          numero_filiais?: number | null
          produto_principal?: string | null
          qtd_comandas?: number | null
          qtd_pdv?: number | null
          qtd_pdv_comandas?: number | null
          razao_social?: string | null
          status?: string | null
          tenant_id?: string
          updated_at?: string
          usuarios_adicionais?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "clientes_oem_tenant_id_fkey"
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
          created_at: string
          intervalo_horas: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          ativo?: boolean
          created_at?: string
          intervalo_horas?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          ativo?: boolean
          created_at?: string
          intervalo_horas?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "oem_sync_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
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
          origem: string
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
            foreignKeyName: "oem_sync_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
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
          doctoroem_publishable_secret_name: string | null
          doctoroem_service_secret_name: string | null
          doctoroem_url: string | null
          oem_api_base_url: string | null
          oem_api_method: string | null
          oem_api_password: string | null
          oem_api_username: string | null
          oem_client_id: string | null
          oem_client_secret: string | null
          tabletcloud_token_secret_name: string | null
          tabletcloud_url: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          doctoroem_publishable_secret_name?: string | null
          doctoroem_service_secret_name?: string | null
          doctoroem_url?: string | null
          oem_api_base_url?: string | null
          oem_api_method?: string | null
          oem_api_password?: string | null
          oem_api_username?: string | null
          oem_client_id?: string | null
          oem_client_secret?: string | null
          tabletcloud_token_secret_name?: string | null
          tabletcloud_url?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          doctoroem_publishable_secret_name?: string | null
          doctoroem_service_secret_name?: string | null
          doctoroem_url?: string | null
          oem_api_base_url?: string | null
          oem_api_method?: string | null
          oem_api_password?: string | null
          oem_api_username?: string | null
          oem_client_id?: string | null
          oem_client_secret?: string | null
          tabletcloud_token_secret_name?: string | null
          tabletcloud_url?: string | null
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
  public: {
    Enums: {
      app_role: ["super_admin"],
      tenant_role: ["admin", "financeiro", "suporte"],
    },
  },
} as const
