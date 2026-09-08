---
title: "fixture: edge syntax"
fake_unit: "- [ ] **U9. Not a real unit (frontmatter)**"
---

# Edge syntax fixture

<!--
- [ ] **U8. Not a real unit (HTML comment)**
**Dependencies:** U9
-->

Some prose with Unicode: 日本語, emoji 🎉, and an em dash — here.

```markdown
- [ ] **U7. Not a real unit (fenced code, backticks)**
**Dependencies:** None
```

~~~
- [ ] **U6. Not a real unit (fenced code, tildes)**
~~~

````
- [ ] **U5. Not a real unit (longer backtick fence)**
```
still inside the outer fence
````

    - [ ] **U4. Not a real unit (indented code block)**

## Implementation Units

- [ ] **U1. Real unit one**

**Dependencies:** None

**Test scenarios:**
- Happy path: does the thing.

**Verification:** It works.

- [x] **U2. Real unit two**

**Dependencies:** U1

**Verification:** Depends on U1 only.

## Next Section

This heading ends the Implementation Units section; nothing here is scanned.

- [ ] **U3. Not a real unit (outside section)**
