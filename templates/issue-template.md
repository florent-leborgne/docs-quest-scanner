## Summary

{{summary}}
{{#if reasoning}}

**Why this needs docs:** {{reasoning}}
{{/if}}

## Resources

{{#each prs}}
- PR [#{{this.number}}]({{this.url}}) — {{this.title}}
{{/each}}
{{#if productIssue}}
- Product issue: {{productIssue}}
{{/if}}
{{#if alsoAppliesTo}}
- Also applies to: {{alsoAppliesTo}}
{{/if}}
{{#if screenshots}}

<details><summary>Screenshots from PR</summary>

{{#each screenshots}}
![screenshot]({{this}})
{{/each}}
</details>
{{/if}}

## Availability

| Channel | Details |
|---------|---------|
| **Stack** | {{stackVersion}} |
| **Serverless** | {{serverlessEstimate}} |
{{#if featureStatus}}
| **Feature status** | {{featureStatus}} |
{{/if}}
| **Feature flag** | {{featureFlag}} |

{{#if createdBy}}
---
*Created with [Docs Quest Scanner](https://github.com/florent-leborgne/docs-quest-scanner) by @{{createdBy}}*

{{/if}}
{{#if docsGap}}
## Suggested edits

{{#each docsGap}}
[{{this.pageTitle}}]({{this.pageUrl}}){{#if this.section}} > {{this.section}}{{/if}}
{{#if this.currentContent}}
- **What the docs say:** {{this.currentContent}}
{{/if}}
- **What to change:** {{this.gap}}

{{/each}}
{{else}}
{{#if existingDocs}}
## Related pages

{{#each existingDocs}}
- {{this}}
{{/each}}
{{/if}}
{{/if}}
