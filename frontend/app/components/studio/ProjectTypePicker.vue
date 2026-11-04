<template>
  <div class="field">
    <span class="field-label">{{ t('studio.typePicker.label') }}</span>
    <div class="type-options">
      <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        class="type-option"
        :class="{ on: current === opt.value }"
        @click="pick(opt.value)"
      >
        <span class="type-option-title">{{ opt.label }}</span>
        <span class="type-option-desc dim">{{ opt.desc }}</span>
      </button>
    </div>
    <span class="field-hint">{{ t('studio.typePicker.hint') }}</span>
  </div>
</template>

<script setup>
/** 新建项目的类型选择器：短剧 / 人物替换 / 首尾帧转场，独立组件避免改动原弹窗样式。 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({ modelValue: { type: String, default: '' } })
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const current = computed(() => props.modelValue || 'drama')
const options = computed(() => ['drama', 'character_swap', 'transition'].map(value => ({
  value,
  label: t(`studio.types.${value}.label`),
  desc: t(`studio.types.${value}.desc`),
})))

function pick(value) { emit('update:modelValue', value) }
</script>

<style scoped>
.type-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.type-option {
  padding: 10px 10px 9px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-1);
  cursor: pointer;
  transition: border-color .18s, background .18s, box-shadow .18s;
}
.type-option:hover { border-color: var(--border-strong); }
.type-option.on {
  border-color: var(--accent);
  background: var(--accent-bg);
  box-shadow: 0 0 0 2px var(--accent-bg);
}
.type-option-title {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-0);
  line-height: 1.4;
}
.type-option-desc {
  display: block;
  margin-top: 3px;
  font-size: 10px;
  line-height: 1.5;
}
@media (max-width: 560px) {
  .type-options { grid-template-columns: 1fr; }
}
</style>
