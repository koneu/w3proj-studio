# Campaign Editor

Extension `w3.campaignEditor`. Edits a campaign project: name, author, description, difficulty, campaign screen and the chapter buttons with their maps.

## Data
Reads and writes map/war3campaign.w3f.json; chapter maps are projects of their own under maps/<name>.w3x/ (their map/war3map.w3i.json and files are read to list and move them); exports and replaces maps as .w3x/.w3m on disk.

## Contributes
- Commands (8): w3.campaign.open, w3.campaign.new, w3.campaign.back, w3.campaign.newMap, w3.campaign.addMap, w3.campaign.exportMap, w3.campaign.replaceMap, w3.campaign.removeMap
- Views (1): w3.campaign.overview
- Editors (1): w3.campaignEditor
- MCP tools (2): set_campaign_info, campaign_info

Full list: `extension.json` in this folder.
