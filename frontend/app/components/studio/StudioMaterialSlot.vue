<template>
  <section class="card slot-card">
    <div class="slot-head">
      <div class="slot-heading">
        <h3 class="slot-title">
          {{ t(`studio.slots.${slotDef.role}.title`) }}
          <span v-if="slotDef.required" class="required">*</span>
        </h3>
        <p class="slot-hint dim">{{ t(`studio.slots.${slotDef.role}.hint`) }}</p>
      </div>
      <span class="tag">{{ items.length }} / {{ slotDef.max }}</span>
    </div>

    <div class="slot-grid">
      <div v-for="item in items" :key="item.id" class="slot-item">
        <img v-if="slotDef.media_type === 'image'" :src="item.url" :alt="item.file_name || ''" />
        <video v-else :src="item.url" controls preload="metadata"></video>
        <button
          type="button"
          class="slot-remove"
          :title="t('studio.slots.remove')"
          :disabled="disabled"
          @click="remove(item)"
        >×</button>
        <span class="slot-name truncate">{{ item.file_name || item.role }}</span>
      </div>

      <label v-if="items.length < slotDef.max" class="slot-upload" :class="{ busy: uploading || disabled }">
        <input
          type="file"
          :accept="accept"
          :disabled="uploading || disabled"
          @change="onFile"
        />
        <span class="slot-upload-icon">+</span>
        <span>{{ uploading ? t('studio.slots.uploading') : t('studio.slots.upload') }}</span>
      </label>
    </div>
  </section>
</template>

<script setup>
/** 单个素材槽位：上传、预览、删除，全部走通用上传接口与工作台素材接口。 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { toastError } from '~/composables/useToast'
import { uploadAPI } from '~/composables/useApi'
import { studioAPI } from '~/composables/useStudio'

const props = defineProps({
  slotDef: { type: Object, required: true },
  items: { type: Array, default: () => [] },
  projectId: { type: Number, required: true },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['changed'])
const { t } = useI18n()
const uploading = ref(false)

const accept = computed(() => props.slotDef.media_type === 'video'
  ? 'video/mp4,video/quicktime,video/webm,video/x-m4v'
  : 'image/*')

async function onFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  // 与后端 /upload/video 的 50MB 限制保持一致，提前拦截避免无效请求
  if (props.slotDef.media_type === 'video' && file.size > 50 * 1024 * 1024) {
    toast.error(t('studio.slots.fileTooLarge'))
    return
  }
  uploading.value = true
  try {
    const res = props.slotDef.media_type === 'video'
      ? await uploadAPI.video(file)
      : await uploadAPI.image(file)
    await studioAPI.addMaterial(props.projectId, {
      role: props.slotDef.role,
      media_type: props.slotDef.media_type,
      url: res.url,
      path: res.path,
      file_name: file.name,
    })
    emit('changed')
  } catch (error) {
    toastError(error)
  } finally {
    uploading.value = false
  }
}

async function remove(item) {
  if (props.disabled) return
  try {
    await studioAPI.delMaterial(item.id)
    emit('changed')
  } catch (error) {
    toastError(error)
  }
}
</script>

<style scoped>
.slot-card { padding: 14px 16px 16px; }
.slot-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.slot-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-0); }
.slot-hint { margin: 3px 0 0; font-size: 11px; line-height: 1.5; }
.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
}
.slot-item {
  position: relative;
  aspect-ratio: 1;
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow: hidden;
  background: var(--bg-2);
}
.slot-item img, .slot-item video { width: 100%; height: 100%; object-fit: cover; display: block; }
.slot-remove {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 20px;
  height: 20px;
  line-height: 18px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, .62);
  color: #fff;
  font-size: 15px;
  cursor: pointer;
}
.slot-remove:disabled { opacity: .4; cursor: not-allowed; }
.slot-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 4px 6px;
  font-size: 10px;
  color: #fff;
  background: linear-gradient(transparent, rgba(0, 0, 0, .68));
}
.slot-upload {
  aspect-ratio: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px dashed var(--border-strong);
  border-radius: 9px;
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 11px;
  cursor: pointer;
  transition: border-color .18s, color .18s;
}
.slot-upload:hover { border-color: var(--accent); color: var(--accent-text); }
.slot-upload.busy { opacity: .55; cursor: not-allowed; }
.slot-upload input { display: none; }
.slot-upload-icon { font-size: 22px; line-height: 1; font-weight: 300; }
</style>
