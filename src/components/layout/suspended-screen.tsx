export function SuspendedScreen({ reason }: { reason?: string | null }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold text-foreground">Cuenta suspendida</h1>
        <p className="text-sm text-muted-foreground">
          Tu acceso a wacrm está temporalmente suspendido
          {reason ? `: ${reason}` : ' por un problema con tu suscripción'}.
          Contacta a tu proveedor de servicio para reactivarlo.
        </p>
      </div>
    </div>
  )
}
