UPDATE public.clientes_oem
   SET status = 'Ativo'
 WHERE bloqueado = false
   AND status IS DISTINCT FROM 'Ativo';