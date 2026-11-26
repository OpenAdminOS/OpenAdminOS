# Sophos Central (Preview)

Sophos documentation may call the console Sophos Fusion.

In Sophos Central, a Super Admin creates a tenant credential under **Global Settings → API Credentials**. Choose **Service Principal Read-Only** for reads or **Service Principal Management** for endpoint isolation and scans. Copy the secret when it appears. Partner, organization and MSP credentials are unsupported in this preview.

Select your OpenAdminOS organization and enter the client ID and secret under **Connections → Sophos Central**. The card shows the tenant's region after the connection succeeds. Use **Test connection** to check the credential. If it expired or was removed, disconnect and connect a new credential.

Chat reads endpoints, alerts, SIEM events and alerts, firewall inventory and groups, and account health. SIEM covers the last 24 hours. The firewall API does not provide traffic logs.

Use **Plan a change** to find endpoints and review their exact IDs, hostnames and proposed change. You can isolate or release endpoints with a reason, or request a scan. Applying a plan always requires the displayed typed phrase. Sophos Central reports whether it accepted each request. Check Sophos Central for the resulting endpoint status.

Credentials are encrypted in this device's secure storage. The app exchanges them at Sophos ID and uses the resulting token to identify the tenant and call its Sophos regional API. Chat results stay on this device with a local model and go to the selected model provider with a hosted model.
