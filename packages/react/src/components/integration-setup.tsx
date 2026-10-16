import { createContext, useContext, type ReactNode } from "react";

const IntegrationSetupContext = createContext<((integration: string) => ReactNode) | null>(null);

/** Host-owned management UI. Plugins retain their normal accounts/credential surface. */
export function IntegrationSetupProvider(props: {
  readonly render: (integration: string) => ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <IntegrationSetupContext.Provider value={props.render}>
      {props.children}
    </IntegrationSetupContext.Provider>
  );
}

export function IntegrationSetupSection(props: { readonly integration: string }) {
  return useContext(IntegrationSetupContext)?.(props.integration) ?? null;
}
