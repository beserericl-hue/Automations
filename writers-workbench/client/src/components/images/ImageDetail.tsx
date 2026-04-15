import { useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import { getImageUrl } from './ImageGallery';
import type { GeneratedImage } from '../../types/database';

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type GenerationState = 'idle' | 'submitting' | 'polling' | 'saving' | 'done' | 'error';

export default function ImageDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile } = useUser();
  const userId = profile?.user_id;

  const [prompt, setPrompt] = useState('');
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [referenceUrl, setReferenceUrl] = useState('');
  const [referencePreview, setReferencePreview] = useState('');
  const [genState, setGenState] = useState<GenerationState>('idle');
  const [genError, setGenError] = useState('');
  const [generatedPreview, setGeneratedPreview] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: image, isLoading } = useQuery({
    queryKey: ['image-detail', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('generated_images_v2')
        .select('*')
        .eq('id', id!)
        .eq('user_id', userId!)
        .single();
      if (error) throw error;
      return data as GeneratedImage;
    },
    enabled: !!id && !!userId,
  });

  // Load prompt from image on first render
  if (image && !promptLoaded) {
    setPrompt(image.original_prompt || '');
    setPromptLoaded(true);
  }

  // Upload reference image
  const uploadReference = useCallback(async (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      setReferencePreview(reader.result as string);

      const headers = await getAuthHeaders();
      const resp = await fetch('/api/images/upload-reference', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base64,
          filename: file.name,
          content_type: file.type,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setReferenceUrl(data.publicUrl);
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadReference(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) uploadReference(file);
  };

  // Generate/regenerate image
  const generateMutation = useMutation({
    mutationFn: async () => {
      setGenError('');
      setGeneratedPreview('');

      // Step 1: Submit to KIE.AI
      setGenState('submitting');
      const headers = await getAuthHeaders();
      const submitResp = await fetch('/api/images/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt,
          reference_image_url: referenceUrl || undefined,
          project_id: image?.project_id,
          genre_slug: image?.genre_slug,
        }),
      });
      const submitData = await submitResp.json();
      if (!submitData.success) throw new Error(submitData.error?.message || 'Failed to submit');

      const taskId = submitData.taskId;

      // Step 2: Poll for completion
      setGenState('polling');
      let imageUrl = '';
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        const statusResp = await fetch(`/api/images/status/${taskId}`, { headers });
        const statusData = await statusResp.json();

        if (statusData.state === 'success') {
          imageUrl = statusData.imageUrl;
          break;
        }
        if (statusData.state === 'failed') {
          throw new Error(statusData.error || 'Image generation failed');
        }
      }

      if (!imageUrl) throw new Error('Generation timed out');

      // Show preview before saving
      setGeneratedPreview(imageUrl);

      // Step 3: Save to storage + DB
      setGenState('saving');
      const title = (image?.metadata as Record<string, string>)?.title
        || (image?.metadata as Record<string, string>)?.story_title
        || 'regenerated';
      const saveResp = await fetch('/api/images/save', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          image_url: imageUrl,
          prompt,
          project_id: image?.project_id,
          genre_slug: image?.genre_slug,
          title,
        }),
      });
      const saveData = await saveResp.json();
      if (!saveData.success) throw new Error(saveData.error?.message || 'Failed to save');

      return saveData;
    },
    onSuccess: (data) => {
      setGenState('done');
      queryClient.invalidateQueries({ queryKey: ['generated-images'] });
      queryClient.invalidateQueries({ queryKey: ['image-detail'] });
      // Navigate to the new image
      if (data.image?.id) {
        setTimeout(() => navigate(`/images/${data.image.id}`), 1500);
      }
    },
    onError: (err: Error) => {
      setGenState('error');
      setGenError(err.message);
    },
  });

  const handleDownload = async () => {
    if (!image) return;
    const url = getImageUrl(image.storage_path);
    const response = await fetch(url);
    const blob = await response.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = image.storage_path.split('/').pop() || 'image.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-sm text-gray-500">Loading...</div>;
  }

  if (!image) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <p className="text-sm text-gray-500">Image not found.</p>
        <button onClick={() => navigate(-1)} className="text-sm text-brand-600 hover:text-brand-700">Go back</button>
      </div>
    );
  }

  const title = (image.metadata as Record<string, string>)?.title
    || (image.metadata as Record<string, string>)?.story_title
    || image.image_type.replace('_', ' ');
  const isGenerating = genState !== 'idle' && genState !== 'done' && genState !== 'error';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <button onClick={() => navigate(-1)} className="text-xs text-gray-400 hover:text-gray-600 mb-1">&larr; Back to gallery</button>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">{title}</h1>
          <div className="mt-1 flex items-center gap-3 text-xs text-gray-400">
            <span>{image.image_type.replace('_', ' ')}</span>
            {image.genre_slug && <span>{image.genre_slug.replace(/-/g, ' ')}</span>}
            <span>{image.generation_model}</span>
            <span>Created {new Date(image.created_at).toLocaleString()}</span>
            {image.width && image.height && <span>{image.width}x{image.height}</span>}
            <span className="rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-400 dark:bg-gray-700">{image.id.substring(0, 8)}</span>
          </div>
        </div>
        <button
          onClick={handleDownload}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Download
        </button>
      </div>

      {/* Main image */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800">
        <img
          src={generatedPreview || getImageUrl(image.storage_path)}
          alt={title}
          className="w-full object-contain max-h-[60vh]"
        />
      </div>

      {/* Prompt editor + Generate section */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Prompt — takes 2/3 */}
        <div className="lg:col-span-2 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Image Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              placeholder="Describe the image you want to generate..."
            />
            <p className="mt-1 text-[10px] text-gray-400">
              Edit the prompt and click Regenerate to create a new version. The original image is preserved.
            </p>
          </div>

          {/* Generate button + status */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => generateMutation.mutate()}
              disabled={isGenerating || !prompt.trim()}
              className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {isGenerating ? getStateLabel(genState) : 'Regenerate Image'}
            </button>

            {genState === 'done' && (
              <span className="text-sm text-green-600">New image saved to gallery</span>
            )}
            {genState === 'error' && (
              <span className="text-sm text-red-500">{genError}</span>
            )}
          </div>
        </div>

        {/* Reference image — takes 1/3 */}
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Reference Image (optional)
          </label>

          {referencePreview ? (
            <div className="relative overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              <img src={referencePreview} alt="Reference" className="w-full object-cover aspect-video" />
              <button
                onClick={() => { setReferencePreview(''); setReferenceUrl(''); }}
                className="absolute top-1 right-1 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              {referenceUrl && (
                <div className="px-2 py-1 text-[10px] text-green-600 bg-green-50 dark:bg-green-950/30 dark:text-green-400">
                  Uploaded and ready
                </div>
              )}
            </div>
          ) : (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 p-6 text-center hover:border-brand-400 dark:border-gray-600 dark:hover:border-brand-500"
            >
              <svg className="h-8 w-8 text-gray-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              <p className="text-sm text-gray-500">Drop an image here or click to upload</p>
              <p className="mt-1 text-[10px] text-gray-400">PNG, JPG up to 10MB. Used as style/composition reference for KIE.AI.</p>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      </div>
    </div>
  );
}

function getStateLabel(state: GenerationState): string {
  switch (state) {
    case 'submitting': return 'Submitting...';
    case 'polling': return 'Generating...';
    case 'saving': return 'Saving...';
    default: return 'Regenerate Image';
  }
}
