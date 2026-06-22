# RFC: wiki-ingest에 Knowledge Synthesis 통합

**상태**: 제안 (Proposal)  
**작성일**: 2026-06-22  
**목표**: wiki-ingest의 Step 2.4 & 3을 제대로 구현하여 LLM Wiki 철학 완성

---

## 1. 현재 문제

### 1.1 wiki-ingest의 설계 vs 실제
```
설계 (SKILL.md):
  Step 2.4: "Update entity/concept/map pages FROM TAKEAWAYS ONLY"
  Step 3: "Merge Pass - combine child-leaf summaries into wiki pages"
  
실제 (지난 토요일 결과):
  ✅ Source pages: 267,110개 생성 (완벽)
  ❌ Entities: 0개
  ❌ Concepts: 5개 (수동 ingest만)
  ❌ Maps: 0개
  → Step 2.4 & 3이 제대로 작동하지 않음
```

### 1.2 근본 원인

**문제 1**: Source card의 "takeaway"가 충분하지 않음
- 대부분 README.md 같은 얇은 요약
- 실제 지식은 많은 파일에 산재
- Per-file 요약으로는 local entity/concept 식별 어려움

**문제 2**: Merge pass (Step 3)의 구조 결함
- 매번 1개 parent만 처리 (one parent per invocation)
- 4,384 leaves → 수백 개 parent → 수백 번 invocation 필요
- Entity/concept 식별에 충분한 context 부족

**문제 3**: 대규모(267K) 자동화의 한계
- 한 번에 모든 source를 읽을 수 없음
- 전체 context 없이 entity 식별 불가능

---

## 2. 해결책: 계층적 Synthesis (Hierarchical Synthesis)

### 2.1 새로운 아키텍처

```
Raw sources (263K files)
  ↓
Step 1: Enumerate leaves (4,384 leaves 식별)
  ↓
Step 2: Process sub-chunks (각 leaf의 source cards 생성)
  ↓
**NEW Step 2.5: Chunk-level Synthesis** ← 추가
  ├─ 같은 parent 아래의 source cards를 그룹화
  ├─ Local context에서 entity/concept/maps 추출
  ├─ wiki/entities/<Entity>.md (chunk-specific)
  └─ wiki/concepts/<Concept>.md (chunk-specific)
  ↓
Step 3: Merge Pass (Global integration)
  ├─ 모든 chunk 결과 수집
  ├─ Entity/concept 중복 제거
  ├─ Global wiki/entities/, concepts/, maps/ 생성
  └─ wiki/index.md, log.md 업데이트
  ↓
Result: wiki fully synthesized (source cards ← 이미 done)
        + entity/concept/maps (new)
        + graph-ready (next step)
```

### 2.2 Chunk-level Synthesis의 이점

```
문제점 해결:
1. ✅ 관리 가능한 크기: parent 아래의 files만 처리
2. ✅ 충분한 context: 수십~수백 files의 content를 함께 본다
3. ✅ 병렬화 가능: 각 parent 독립적으로 처리 가능
4. ✅ 점진적: 각 chunk 완료 후 즉시 entity/concept 생성

성능:
- Sequential: ~O(leaves) × O(avgChunkSize)
- Parallel: ~O(maxParentSize) (병렬화 가능)
- 267K scale: 가능 (4,384 parents, 각 최대 수백 files)
```

### 2.3 구현 아키텍처

```
wiki-ingest (통합 skill):

Step 1: Enumerate leaves
  └─ 4,384 leaves 식별

Step 2: Process sub-chunks
  ├─ 각 sub-chunk (최대 4 files)
  ├─ wiki/sources/<path>.md 생성
  └─ Per-leaf JSON에 takeaways 저장

Step 2.5: Chunk-level Synthesis (NEW)
  ├─ Trigger: leaf 완료 시
  ├─ 같은 parent의 모든 leaf 완료 확인
  ├─ Parent 아래 모든 source cards 읽기
  ├─ LLM: "이 parent 아래 파일들의 entity/concept/maps는?"
  ├─ wiki/entities/<Entity>.md (parent-scoped)
  ├─ wiki/concepts/<Concept>.md (parent-scoped)
  └─ wiki/maps/<Topic>.md (parent-scoped)

Step 3: Merge Pass
  ├─ Trigger: 모든 parents 완료 시
  ├─ 모든 parent-scoped entities/concepts 수집
  ├─ "AppEvent (Confluence)" + "AppEvent (Vault)" → "AppEvent (Global)"
  ├─ wiki/entities/<Entity>.md (global, unified)
  ├─ wiki/concepts/<Concept>.md (global, unified)
  └─ wiki/index.md, wiki/log.md 최종 업데이트

Step 4: Optional Graph
  └─ wiki-graphify update (별도 invocation)
```

---

## 3. 구현 계획

### Phase 1: wiki-ingest Step 2.5 추가 (Chunk-level Synthesis)

**변경사항**:
- SKILL.md: Step 2.5 추가 (문서화)
- workflow: Step 2 → Step 2.5 → Step 3 순서 변경

**Step 2.5 알고리즘**:
```
For each completed parent directory:
  1. Collect all source cards under parent/
  2. Read each source card frontmatter + summary
  3. Call LLM:
     "Given these wiki/sources/{parent}/**/*.md files,
      identify key entities, concepts, and maps.
      Output: entities[], concepts[], maps[]"
  4. Create wiki/entities/<Entity>.md (parent-scoped)
  5. Create wiki/concepts/<Concept>.md (parent-scoped)
  6. Create wiki/maps/<Topic>.md (parent-scoped)
  7. Update wiki/log.md: "chunk synthesis for {parent}"
```

**예상 결과**:
- Parent-level entities: 200-500개 (sub-trees)
- Parent-level concepts: 100-300개
- Parent-level maps: 50-100개

### Phase 2: Merge Pass (Step 3) 강화

**변경사항**:
- Step 3: entity/concept 중복 제거 및 통합

**Step 3 알고리즘**:
```
1. Collect all parent-scoped entities
2. Group by name similarity:
   - "AppEvent" (Confluence) + "AppEvent" (Vault)
   - "TizenFramework" (Confluence) + "Tizen-Framework" (Vault)
3. Merge each group:
   - Keep: unified name, combined descriptions
   - Sum: mention counts (45 + 8 = 53)
   - Track: chunk_sources = ["Confluence", "Vault"]
4. Create global wiki/entities/<Entity>.md
5. Same for concepts and maps
6. Update wiki/index.md with all merged entities
7. Final wiki/log.md entry
```

**예상 결과**:
- Global entities: 75-150개
- Global concepts: 50-100개
- Global maps: 20-50개

---

## 4. 기대 효과

### Before (지난 토요일)
```
✅ Source pages: 267,110개
❌ Entities: 0개
❌ Concepts: 5개 (수동)
❌ Maps: 0개
→ wiki = 색인 시스템
```

### After (이 RFC 구현 후)
```
✅ Source pages: 267,110개 (유지)
✅ Chunk-level entities: 200-500개 (intermediate)
✅ Global entities: 75-150개 (merged)
✅ Global concepts: 50-100개
✅ Global maps: 20-50개
✅ Graph-ready: next invocation에 wiki-graphify update 가능
→ wiki = 완전한 지식베이스
```

### LLM Wiki 철학 복원
```
"When you add a new source, the LLM doesn't just index it for 
later retrieval. It reads it, extracts the key information, and 
integrates it into the existing wiki — updating entity pages, 
revising topic summaries, noting where new data contradicts old 
claims..."

✅ 이제 ingest 단계에서 이 모든 일이 일어남
✅ "knowledge is compiled once and then kept current"
```

---

## 5. 구현 우선순위

### P0 (필수)
- [ ] SKILL.md Step 2.5 문서화
- [ ] workflow에 Step 2.5 추가
- [ ] Parent-scoped entity/concept 생성 로직
- [ ] Step 3 merge 로직

### P1 (권장)
- [ ] Chunk-level map 생성
- [ ] Entity/concept 중복 제거 개선 (유사도 기반)
- [ ] Performance optimization (병렬화)

### P2 (선택)
- [ ] Graph auto-update 연동
- [ ] Visualization 개선

---

## 6. 위험 및 완화

### 위험 1: Merge 단계에서 false merges
**예**: "AppEvent" (Tizen event) vs "AppEvent" (다른 뜻)
**완화**: 
- 더블-check merge (유사도 threshold)
- Manual review option
- Detailed diff in wiki/log.md

### 위험 2: Performance 저하
**예**: 267K scale에서 parent별 LLM call = 수백 calls
**완화**:
- Batch processing (여러 parent 한 call)
- Caching per parent
- Parallel processing

### 위험 3: Context window 부족
**예**: Large parent의 모든 source cards 한 번에 읽을 수 없음
**완화**:
- Chunk parent into sub-groups
- Top-N source prioritization
- Iterative refinement

---

## 7. 대안 검토

### 대안 A: 현재 상태 유지 (Not recommended)
```
장점: 변경 없음
단점: wiki synthesis 거의 없음, LLM Wiki 철학 미구현
```

### 대안 B: wiki-synthesize 별도 skill (이전 제안)
```
장점: 분리된 구조, 독립적 실행
단점: wiki-ingest와 분리 → LLM Wiki 철학 위배
           "knowledge compiled once" 불만족
           사용자가 매번 두 skill 실행해야 함
결론: ❌ Rejected (이번 사용자 지적)
```

### 대안 C: wiki-ingest에 synthesis 통합 (권장)
```
장점: ✅ LLM Wiki 철학 완전 구현
       ✅ Single workflow (ingest = synthesis 포함)
       ✅ "knowledge compiled once"
       ✅ 자동화된 지식베이스 구축
단점: wiki-ingest 구조 변경 필요
      구현 복잡도 증가
결론: ✅ Recommended (사용자 지적 반영)
```

---

## 8. 결론

wiki-ingest를 **Step 2.5 (Chunk-level Synthesis) + Step 3 개선**으로 강화하면:

1. ✅ LLM Wiki의 핵심 철학 구현
2. ✅ 267K scale의 자동화 달성
3. ✅ Single workflow로 지식베이스 완성
4. ✅ Source card + Entity/Concept + Graph까지 자동 생성

이것이 llm-wiki.md가 의도한 방식입니다.

---

## 관련 파일

- `llm-wiki.md` - LLM Wiki 패턴 설명
- `CLAUDE.md` - 프로젝트 운영 규칙 (§3.1 Ingest)
- `.agents/skills/wiki-ingest/SKILL.md` - 현재 ingest 스킬
