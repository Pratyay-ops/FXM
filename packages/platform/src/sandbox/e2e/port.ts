/** The test network's proxy port: 5510 unless FXM_SANDBOX_E2E_PORT says otherwise. */
export const E2E_PORT = Number(process.env.FXM_SANDBOX_E2E_PORT ?? 5510)
