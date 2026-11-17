import React from 'react';
import { Boxes, Clock } from 'lucide-react';
import type { InventoryItemPreview } from '../../shared/types/domain';

const PLANNED_SCHEMA: InventoryItemPreview[] = [
  {
    sku: 'SKU-BFM-101',
    name: 'Cold Pressed Mustard Oil 1L',
    category: 'Staples',
    openingStock: 80,
    received: 40,
    sold: 52,
    damaged: 1,
    currentStock: 67,
    lowStockThreshold: 20,
  },
  {
    sku: 'SKU-BFM-204',
    name: 'Organic Basmati Rice 5kg',
    category: 'Grains',
    openingStock: 45,
    received: 15,
    sold: 48,
    damaged: 0,
    currentStock: 12,
    lowStockThreshold: 15,
  },
];

export const InventoryComingSoon: React.FC = () => {
  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-slate-100 rounded-lg text-slate-700 shrink-0">
            <Boxes className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-amber-700 mb-1">
              <Clock className="w-3.5 h-3.5" />
              <span>Phase 2 Roadmap · Coming Soon (Not Yet Active in MVP)</span>
            </div>
            <h2 className="text-lg font-semibold text-slate-900">
              Multi-Outlet Inventory &amp; Stock Ledger
            </h2>
            <p className="mt-1 text-sm text-slate-600 max-w-2xl">
              This module is architected for Phase 2 rollout after store camera and manual payment reconciliation stabilize. Planned capabilities include product SKUs, opening stock, stock received, manual stock sold adjustments, damaged write-offs, and low-stock alerts across outlets.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">
            Planned Data Schema Preview (DEMO DATA — Read-Only Blueprint)
          </h3>
          <span className="text-xs text-slate-500">Manual updates by authorized workers</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">SKU</th>
                <th className="py-3 px-4">Product Name</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4 text-right">Opening</th>
                <th className="py-3 px-4 text-right">Received</th>
                <th className="py-3 px-4 text-right">Sold</th>
                <th className="py-3 px-4 text-right">Damaged</th>
                <th className="py-3 px-4 text-right">Current Stock</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm text-slate-600">
              {PLANNED_SCHEMA.map((item) => (
                <tr key={item.sku}>
                  <td className="py-3 px-4 font-mono text-xs">{item.sku}</td>
                  <td className="py-3 px-4 font-medium text-slate-800">{item.name}</td>
                  <td className="py-3 px-4">{item.category}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">{item.openingStock}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">{item.received}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">{item.sold}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">{item.damaged}</td>
                  <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums">
                    {item.currentStock}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
