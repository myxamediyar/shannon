interface FeatureCardProps {
  icon: string;
  title: string;
  description: string;
}

export default function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex flex-col gap-3 p-5 rounded-xl bg-white border border-slate-200 shadow-sm">
      <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl bg-sky-100">
        {icon}
      </div>
      <h3 className="font-semibold text-slate-800 text-base">{title}</h3>
      <p className="text-sm text-slate-600">
        {description}
      </p>
    </div>
  );
}
