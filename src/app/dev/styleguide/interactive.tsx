'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { CodeInput } from '@/components/auth/code-input';

export function InteractiveDemos() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const toast = useToast();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setOpen(true)}>Open dialog</Button>
        <Button variant="secondary" onClick={() => toast({ title: 'Saved', description: 'Your progress is saved.', tone: 'success' })}>
          Success toast
        </Button>
        <Button
          variant="ghost"
          onClick={() => toast({ title: 'Document approved', tone: 'info', duration: 8000, action: { label: 'Undo', onClick: () => undefined } })}
        >
          Undo toast
        </Button>
        <Button variant="danger" onClick={() => toast({ title: 'Upload failed', description: 'Check your connection and try again.', tone: 'error' })}>
          Error toast
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Reject document"
        description="Choose a reason. The student sees it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              Reject
            </Button>
          </>
        }
      >
        <Select label="Reason" options={[{ value: 'glare', label: 'Glare hides details' }]} placeholder="Choose a reason" />
      </Dialog>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Full name (as in passport)" hint="Exactly as printed." placeholder="Amani Wanjiru" />
        <Input label="Student number" error="Enter your student number." />
        <Select
          label="Student type"
          placeholder="Choose..."
          options={[
            { value: 'new', label: 'New' },
            { value: 'continuing', label: 'Continuing' },
            { value: 'masters', label: 'Masters' },
          ]}
        />
      </div>
      <div className="max-w-sm">
        <CodeInput value={code} onChange={setCode} />
      </div>
      <Tabs
        items={[
          { id: 'timeline', label: 'Timeline', content: <p>Submitted, then being checked</p> },
          { id: 'messages', label: 'Messages', content: <p>No messages yet.</p> },
        ]}
      />
    </div>
  );
}
