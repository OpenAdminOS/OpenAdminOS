# Intune Chat question bank

This bank captures the first 150 natural-language questions OpenAdminOS should
handle in Intune Chat. It is grounded in current community demand and Microsoft
Graph resource availability, then mapped to the local Graph cache resource names
used by the desktop host.

## Research signals

- Reddit admins repeatedly ask why apps, policies, scripts, and remote actions
  only apply for the enrolling or primary user, and how user/device assignment
  changes behavior: https://www.reddit.com/r/Intune/comments/1s143vy/intune_apppolicy_deployments/
- Autopilot questions cluster around ESP size, app dependency order, and what
  should install before first sign-in: https://www.reddit.com/r/Intune/comments/1rnlcnp/autopilot_and_apps_deployment/
- Compliance questions often involve "Not Evaluated", grace period behavior, and
  Conditional Access lockouts during enrollment:
  https://www.reddit.com/r/Intune/comments/1r9s28z/compliance_status_not_evaluated_sanity_check/
- Remediation demand is high around scripts that run locally but do not report,
  detection/remediation exit-code mistakes, and Intune Management Extension
  delays: https://www.reddit.com/r/Intune/comments/1tozpm5/remediation_script_not_executed/
  and https://www.reddit.com/r/Intune/comments/1tkm0t4/monitoring_and_remediation_script_results_not/
- Windows Update questions commonly ask why feature updates are not offered even
  when devices are active and in scope:
  https://www.reddit.com/r/Intune/comments/1rxa5tr/advice_for_intune_devices_not_receiving_feature/
- Microsoft Graph coverage used for this pass includes managed devices,
  compliance policies, Conditional Access policies, Autopilot devices,
  configuration policies, detected apps, and managed app policy resources:
  https://learn.microsoft.com/en-us/graph/api/resources/intune-devices-manageddevice
  https://learn.microsoft.com/en-us/graph/api/intune-deviceconfig-devicecompliancepolicy-list
  https://learn.microsoft.com/en-us/graph/api/conditionalaccessroot-list-policies
  https://learn.microsoft.com/en-us/graph/api/intune-enrollment-windowsautopilotdeviceidentity-list
  https://learn.microsoft.com/en-us/graph/api/resources/intune-deviceconfigv2-devicemanagementconfigurationpolicy
  https://learn.microsoft.com/en-us/graph/api/intune-devices-detectedapp-get
  https://learn.microsoft.com/en-us/graph/api/resources/intune-mam-managedmobileapp

## Top 150 questions

### Device inventory and sync

1. Which managed devices have not synced in the last 7 days? [managedDevices, entraDevices]
2. Which Windows devices have not synced in the last 30 days? [managedDevices, entraDevices]
3. Which enrolled devices are stale in Intune but still active in Entra? [managedDevices, entraDevices]
4. Which Entra devices do not have a matching Intune managed device? [managedDevices, entraDevices]
5. Which Intune devices do not have a matching Entra device object? [managedDevices, entraDevices]
6. Which devices have duplicate names or duplicate serial numbers? [managedDevices, entraDevices]
7. Which devices are personal-owned but look like corporate hardware? [managedDevices]
8. Which company-owned devices are assigned to no primary user? [managedDevices, users]
9. Which devices changed primary user recently? [managedDevices, directoryAudits, users]
10. Which devices are enrolled but have never checked in after enrollment? [managedDevices]

### Compliance and Conditional Access

11. Which devices are noncompliant and what policies appear related? [managedDevices, deviceCompliancePolicies]
12. Which devices are stuck in Not Evaluated compliance state? [managedDevices, deviceCompliancePolicies]
13. Which newly enrolled devices are still in compliance grace period? [managedDevices, deviceCompliancePolicies]
14. Which users are blocked by Conditional Access because their device is not compliant? [signIns, conditionalAccessPolicies, managedDevices, users]
15. Which Conditional Access policies depend on device compliance? [conditionalAccessPolicies]
16. Which compliance policies have no assignments? [deviceCompliancePolicies, groups]
17. Which compliance policies were modified recently? [deviceCompliancePolicies, directoryAudits]
18. Which devices are in conflict or error compliance states? [managedDevices, deviceCompliancePolicies]
19. Which platforms have the highest noncompliance rate? [managedDevices, deviceCompliancePolicies]
20. Which noncompliant devices are still accessing Microsoft 365 successfully? [managedDevices, signIns, conditionalAccessPolicies]

### App deployment and Company Portal

21. Which required apps are assigned but not installed on targeted devices? [mobileApps, detectedApps, managedDevices, groups]
22. Which devices are missing our required VPN app? [mobileApps, detectedApps, managedDevices]
23. Which Win32 apps are assigned during Autopilot ESP? [mobileApps, windowsAutopilotProfiles]
24. Which apps are assigned to user groups instead of device groups? [mobileApps, groups, users]
25. Which apps are available in Company Portal but not required? [mobileApps]
26. Which app deployments appear tied to the primary user? [mobileApps, managedDevices, users, groups]
27. Which app dependencies might make Autopilot slow? [mobileApps, windowsAutopilotProfiles]
28. Which superseded apps are still detected on devices? [mobileApps, detectedApps, managedDevices]
29. Which devices have old versions of a detected application? [detectedApps, managedDevices]
30. Which app assignments target empty or stale groups? [mobileApps, groups]

### Autopilot and enrollment

31. Which Autopilot devices are not enrolled yet? [windowsAutopilotDevices]
32. Which Autopilot devices are in failed enrollment state? [windowsAutopilotDevices, autopilotEvents, troubleshootingEvents]
33. Which Autopilot devices have no deployment profile? [windowsAutopilotDevices, windowsAutopilotProfiles]
34. Which deployment profiles make the enrolling user a local admin? [windowsAutopilotProfiles]
35. Which deployment profiles use self-deploying mode? [windowsAutopilotProfiles]
36. Which devices have stale Autopilot last-contact times? [windowsAutopilotDevices]
37. Which Autopilot devices have group tags that do not match our naming pattern? [windowsAutopilotDevices]
38. Which enrollment configurations apply to Windows devices? [deviceEnrollmentConfigurations, windowsAutopilotProfiles]
39. Which enrollment profiles are assigned to the most devices? [windowsAutopilotProfiles, windowsAutopilotDevices]
40. Which Autopilot devices are imported but not matched to managed devices? [windowsAutopilotDevices, managedDevices]

### Remediations, scripts, and IME

41. Which remediation scripts have not reported results recently? [deviceHealthScripts, troubleshootingEvents]
42. Which remediations are assigned but have no device results? [deviceHealthScripts, groups, managedDevices]
43. Which scripts run as the logged-on user versus system? [deviceHealthScripts, deviceManagementScripts]
44. Which PowerShell scripts enforce signature checks? [deviceHealthScripts, deviceManagementScripts]
45. Which remediations were changed in the last 30 days? [deviceHealthScripts, directoryAudits]
46. Which devices are likely affected by Intune Management Extension delays? [managedDevices, troubleshootingEvents, deviceHealthScripts]
47. Which remediation scripts might be detection-only? [deviceHealthScripts]
48. Which devices have troubleshooting events tied to script failures? [troubleshootingEvents, managedDevices, deviceHealthScripts]
49. Which platform scripts are assigned to all devices? [deviceManagementScripts, groups]
50. Which remediations are high risk because they restart services or modify registry settings? [deviceHealthScripts]

### Windows updates

51. Which devices are not on the target Windows feature update? [managedDevices, windowsFeatureUpdateProfiles]
52. Which devices should have received 25H2 but have not? [managedDevices, windowsFeatureUpdateProfiles]
53. Which feature update policies are assigned? [windowsFeatureUpdateProfiles, groups]
54. Which quality update policies are assigned? [windowsQualityUpdateProfiles, groups]
55. Which update rings might conflict with feature update policies? [deviceConfigurations, configurationPolicies, windowsFeatureUpdateProfiles]
56. Which Windows devices are below the supported OS build? [managedDevices]
57. Which update policies were changed recently? [windowsFeatureUpdateProfiles, windowsQualityUpdateProfiles, directoryAudits]
58. Which devices are active and syncing but missing from feature update progress? [managedDevices, windowsFeatureUpdateProfiles]
59. Which update policies target user groups rather than device groups? [windowsFeatureUpdateProfiles, windowsQualityUpdateProfiles, groups]
60. Which devices have not synced since the last patch deadline? [managedDevices, windowsQualityUpdateProfiles]

### Configuration and endpoint security

61. Which settings catalog policies are not assigned? [configurationPolicies]
62. Which configuration profiles have conflicts or errors? [configurationPolicies, deviceConfigurations, troubleshootingEvents]
63. Which endpoint security policies are assigned to all devices? [endpointSecurityIntents, groups]
64. Which firewall policies target Windows devices? [endpointSecurityIntents, configurationPolicies]
65. Which Defender or ASR policies are unassigned? [endpointSecurityIntents]
66. Which administrative template policies overlap with settings catalog policies? [groupPolicyConfigurations, configurationPolicies]
67. Which policies were modified in the last week? [configurationPolicies, deviceConfigurations, endpointSecurityIntents, directoryAudits]
68. Which policies target personal devices? [configurationPolicies, assignmentFilters, managedDevices]
69. Which configuration profiles still use legacy device configuration APIs? [deviceConfigurations, configurationPolicies]
70. Which security baselines appear duplicated by newer endpoint security policies? [endpointSecurityIntents, configurationPolicies]

### Mobile and app protection

71. Which iOS app protection policies are assigned? [iosManagedAppProtections, groups]
72. Which Android app protection policies are assigned? [androidManagedAppProtections, groups]
73. Which managed app policies have no targeted apps? [managedAppPolicies, mobileApps]
74. Which app configuration policies target Outlook or Teams? [mobileAppConfigurations, mobileApps]
75. Which mobile app protection policies allow data transfer to unmanaged apps? [iosManagedAppProtections, androidManagedAppProtections]
76. Which mobile policies require a PIN? [iosManagedAppProtections, androidManagedAppProtections]
77. Which Android work-profile devices are noncompliant? [managedDevices, deviceCompliancePolicies]
78. Which iOS devices are not supervised? [managedDevices]
79. Which mobile devices have not checked in recently? [managedDevices]
80. Which app protection policies were changed recently? [managedAppPolicies, iosManagedAppProtections, androidManagedAppProtections, directoryAudits]

### Assignments, filters, groups, and scope tags

81. Which assignment filters are disabled or unused? [assignmentFilters]
82. Which assignment filters target Windows devices? [assignmentFilters]
83. Which apps or policies use assignment filters? [assignmentFilters, mobileApps, configurationPolicies]
84. Which scope tags exist in the tenant? [roleScopeTags]
85. Which policies have custom scope tags? [roleScopeTags, configurationPolicies, deviceCompliancePolicies]
86. Which groups are empty but used for assignments? [groups, mobileApps, configurationPolicies]
87. Which dynamic groups might be stale? [groups, managedDevices, users]
88. Which assignments include all users or all devices? [groups, mobileApps, configurationPolicies, deviceCompliancePolicies]
89. Which assignments exclude break-glass or admin groups? [groups, conditionalAccessPolicies]
90. Which policies are assigned to both user and device groups? [groups, configurationPolicies]

### Sign-ins, risk, and audit

91. Which recent sign-ins failed because of Conditional Access? [signIns, conditionalAccessPolicies]
92. Which users have repeated MFA failures? [signIns, users]
93. Which risky sign-ins came from unmanaged devices? [signIns, managedDevices, entraDevices]
94. Which sign-ins came from noncompliant devices? [signIns, managedDevices]
95. Which apps are most often blocked by Conditional Access? [signIns, conditionalAccessPolicies]
96. Who changed a Conditional Access policy recently? [directoryAudits, conditionalAccessPolicies, users]
97. Who changed an Intune configuration policy recently? [directoryAudits, configurationPolicies, users]
98. Which device records were deleted recently? [directoryAudits, managedDevices, entraDevices]
99. Which group membership changes affected Intune assignments? [directoryAudits, groups]
100. Which directory audit events look related to an enrollment failure? [directoryAudits, windowsAutopilotDevices, managedDevices]

### Encryption, LAPS, and device security posture

101. Which Windows devices are not encrypted? [managedDevices, managedDeviceEncryptionStates]
102. Which devices are missing escrowed BitLocker recovery state? [managedDevices, managedDeviceEncryptionStates]
103. Which macOS devices are missing FileVault escrow? [managedDevices, managedDeviceEncryptionStates]
104. Which devices have stale local admin password rotation signals? [managedDevices, endpointSecurityIntents]
105. Which endpoint security policies configure BitLocker? [endpointSecurityIntents, configurationPolicies]
106. Which devices report high malware or Defender issues? [managedDevices, endpointSecurityIntents]
107. Which devices are missing Secure Boot readiness signals? [managedDevices, deviceHealthScripts]
108. Which security policies changed before noncompliance increased? [endpointSecurityIntents, deviceCompliancePolicies, directoryAudits]
109. Which encrypted devices are still noncompliant? [managedDevices, managedDeviceEncryptionStates, deviceCompliancePolicies]
110. Which devices should be prioritized for security remediation? [managedDevices, deviceHealthScripts, endpointSecurityIntents]

### Platform-specific operations

111. Which macOS devices are not on the expected OS version? [managedDevices]
112. Which iOS devices are jailbroken or unmanaged? [managedDevices, deviceCompliancePolicies]
113. Which Android Enterprise devices have not synced recently? [managedDevices]
114. Which Linux devices are enrolled and active? [managedDevices]
115. Which ChromeOS devices are visible in Intune? [managedDevices]
116. Which platform has the most failed policy assignments? [managedDevices, configurationPolicies, troubleshootingEvents]
117. Which platform has the most stale devices? [managedDevices, managedDeviceOverview]
118. Which platform has the most app deployment gaps? [managedDevices, mobileApps, detectedApps]
119. Which platform-specific policies have no matching devices? [configurationPolicies, managedDevices]
120. Which enrollment types are most common across the tenant? [managedDevices, deviceEnrollmentConfigurations]

### Tenant health and reporting

121. Give me a tenant health summary for devices, compliance, apps, and sign-ins. [managedDevices, deviceCompliancePolicies, mobileApps, signIns]
122. What changed in the tenant in the last 24 hours? [directoryAudits, troubleshootingEvents]
123. Which cache sources are stale and should be refreshed? [managedDeviceOverview]
124. Which device categories have the most noncompliance? [managedDevices, deviceCompliancePolicies]
125. Which app or policy areas have the most assignment coverage gaps? [mobileApps, configurationPolicies, deviceCompliancePolicies, groups]
126. Which resources have Graph refresh errors? [troubleshootingEvents]
127. Which devices are both stale and noncompliant? [managedDevices, deviceCompliancePolicies]
128. Which users have the most device issues? [users, managedDevices, signIns]
129. Which groups drive the most policy and app assignments? [groups, mobileApps, configurationPolicies, deviceCompliancePolicies]
130. What are the top risks visible from cached tenant data? [managedDevices, signIns, conditionalAccessPolicies, endpointSecurityIntents]

### Safe action planning

131. Which devices look safe candidates for retirement? [managedDevices, entraDevices]
132. Which stale devices should not be retired because they recently signed in? [managedDevices, entraDevices, signIns]
133. Which apps could be cleaned up because they are unassigned? [mobileApps]
134. Which unused assignment groups could be reviewed? [groups, mobileApps, configurationPolicies]
135. Which policies look duplicated and need review? [configurationPolicies, deviceConfigurations, endpointSecurityIntents]
136. Which write agent could handle stale device cleanup? [managedDevices, entraDevices]
137. What should I check before retiring stale Windows devices? [managedDevices, entraDevices, signIns]
138. What should I check before changing a Conditional Access policy? [conditionalAccessPolicies, signIns, groups, users]
139. What should I check before moving an app from user assignment to device assignment? [mobileApps, groups, managedDevices, users]
140. What should I check before enabling a stricter compliance policy? [deviceCompliancePolicies, managedDevices, conditionalAccessPolicies]

### Correlation and root-cause questions

141. Why did this device stop receiving policies? [managedDevices, configurationPolicies, troubleshootingEvents]
142. Why did this user's apps not install on the second login? [managedDevices, users, mobileApps, detectedApps]
143. Why is this Autopilot device stuck during ESP? [windowsAutopilotDevices, windowsAutopilotProfiles, mobileApps, troubleshootingEvents]
144. Why is this device compliant in policy status but not evaluated overall? [managedDevices, deviceCompliancePolicies, conditionalAccessPolicies]
145. Why are remediation results missing even though scripts ran locally? [deviceHealthScripts, troubleshootingEvents, managedDevices]
146. Why are feature updates not offered to active devices? [managedDevices, windowsFeatureUpdateProfiles, deviceConfigurations]
147. Why did a sign-in fail after the device became noncompliant? [signIns, managedDevices, conditionalAccessPolicies]
148. Why did a newly enrolled device become local admin for the enrolling user? [windowsAutopilotProfiles, managedDevices, users]
149. Why did an app deployment start only after the primary user signed in? [mobileApps, managedDevices, users, groups]
150. Why did a policy assignment miss devices that are clearly in the target group? [configurationPolicies, assignmentFilters, groups, managedDevices]
